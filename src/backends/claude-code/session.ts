import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentEvent, AgentSession, RunningSession, SessionRequest, TerminalReason } from "../../engine/types.js";

export interface ClaudeCodeOptions {
  /** Executable to run. Defaults to `claude`; tests inject a fake. */
  command?: string;
  /** Time between SIGTERM and SIGKILL of the process group in close(). */
  killGraceMs?: number;
}

type Rec = Record<string, unknown>;

/*
 * Result-event shape, verified against the pinned CLI (claude 2.1.296): a run that hits
 * --max-turns ends with {"type":"result","subtype":"error_max_turns","terminal_reason":"max_turns",
 * "is_error":true,"session_id":...}. Both fields are emitted; either maps to 'max_turns' so older
 * or newer CLIs that emit only one still work.
 */
function mapTerminalReason(r: Rec): TerminalReason {
  if (r.terminal_reason === "max_turns" || r.subtype === "error_max_turns") return "max_turns";
  if (r.is_error === true || (typeof r.subtype === "string" && r.subtype.startsWith("error"))) return "error";
  return "completed";
}

export function buildArgs(req: SessionRequest): string[] {
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--model",
    req.model.name,
    "--max-turns",
    String(req.model.maxTurns),
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    req.systemPrompt,
    "-p",
    "-",
  ];
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  return args;
}

/** Minimal unbounded async queue feeding the event iterator. */
class EventQueue {
  private items: AgentEvent[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;

  push(e: AgentEvent): void {
    this.items.push(e);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    this.waiter?.();
    this.waiter = undefined;
  }

  async *iterate(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
}

/** Splits a stream into lines; the trailing partial line is flushed on end. */
function lineReader(onLine: (line: string) => void): { write(chunk: string): void; end(): void } {
  let buf = "";
  return {
    write(chunk) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = "";
    },
  };
}

export class ClaudeCodeSession implements AgentSession {
  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  async start(req: SessionRequest): Promise<RunningSession> {
    const command = this.options.command ?? "claude";
    const graceMs = this.options.killGraceMs ?? 3000;
    const queue = new EventQueue();
    const child: ChildProcess = spawn(command, buildArgs(req), {
      cwd: req.cwd,
      env: req.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so close() can kill the CLI and everything it spawned.
      detached: true,
    });

    let exited = false;
    let exitCode: number | null = null;
    let sawResult = false;
    let sessionId: string | undefined;
    let spawnError: Error | undefined;
    const exitedP = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve();
      });
      child.once("error", (err) => {
        spawnError = err;
        exited = true;
        resolve();
      });
    });

    const handleLine = (line: string) => {
      if (line.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        queue.push({ schemaVersion: 1, type: "activity", payload: { unparsed: line }, raw: line });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        queue.push({ schemaVersion: 1, type: "activity", payload: parsed, raw: line });
        return;
      }
      const rec = parsed as Rec;
      const sid = typeof rec.session_id === "string" && rec.session_id !== "" ? rec.session_id : undefined;
      if (rec.type === "result") {
        sawResult = true;
        queue.push({
          schemaVersion: 1,
          type: "result",
          sessionId: sid ?? sessionId ?? "",
          terminalReason: mapTerminalReason(rec),
          isError: rec.is_error === true,
          payload: rec,
          raw: line,
        });
      } else if (sid && sessionId === undefined) {
        sessionId = sid;
        queue.push({ schemaVersion: 1, type: "session_started", sessionId: sid, raw: line });
      } else {
        queue.push({ schemaVersion: 1, type: "activity", payload: rec, raw: line });
      }
    };

    // stdout and stderr share one line pipeline, as with stderr=STDOUT in the Python runner.
    const readers = [child.stdout, child.stderr].map((stream) => {
      const r = lineReader(handleLine);
      stream?.setEncoding("utf8");
      stream?.on("data", (c: string) => r.write(c));
      return { r, done: new Promise<void>((res) => (stream ? void stream.once("close", () => res()) : res())) };
    });

    void (async () => {
      await exitedP;
      // After exit, stdio may be held open by a stray grandchild; do not wait forever.
      await Promise.race([Promise.all(readers.map((x) => x.done)), new Promise<void>((r) => setTimeout(r, 500))]);
      readers.forEach((x) => x.r.end());
      if (spawnError) {
        queue.push({ schemaVersion: 1, type: "error", message: `failed to start ${command}: ${spawnError.message}` });
      } else if (!sawResult && exitCode !== 0) {
        queue.push({ schemaVersion: 1, type: "error", message: `claude exited with code ${exitCode ?? "signal"} without a result` });
      }
      queue.end();
    })();

    // Not awaited: a large prompt must not block reading stdout.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(req.prompt);

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // group already gone
      }
    };

    const session: RunningSession = {
      events: queue.iterate(),
      async close() {
        if (!exited) {
          killGroup("SIGTERM");
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), graceMs)));
          const winner = await Promise.race([exitedP.then(() => "exit" as const), timedOut]);
          clearTimeout(timer);
          if (winner === "timeout") {
            killGroup("SIGKILL");
            await exitedP;
          }
        }
        // Also reap any descendants that outlived the CLI's own exit while the group still exists.
        killGroup("SIGKILL");
      },
    };
    if (child.pid !== undefined) session.pid = child.pid;
    return session;
  }
}
