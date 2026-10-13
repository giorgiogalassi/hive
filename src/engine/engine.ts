import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../agents/loader.js";
import { BOT_MARKER } from "../vcs/port.js";
import type { VcsPort } from "../vcs/port.js";
import { buildChildEnv } from "./env.js";
import { CONTINUE_PROMPT, buildPrUserMessage, buildUserMessage } from "./prompts.js";
import type { BackendRegistry } from "./registry.js";
import type { AgentEvent, RunTarget, RunningSession, WorkspacePort } from "./types.js";

type ResultEvent = Extract<AgentEvent, { type: "result" }>;

export interface EngineDeps {
  registry: BackendRegistry;
  workspace: WorkspacePort;
  vcs: VcsPort;
  githubToken: string;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to stderr. */
  log?: (line: string) => void;
}

export interface RunOutcome {
  needsSalvage: boolean;
  salvaged: boolean;
  iterations: number;
  failed: boolean;
}

type IterationEnd =
  | { kind: "result"; result: ResultEvent }
  | { kind: "ended" } // stream ended / errored without a result
  | { kind: "timeout"; reason: "idle" | "overall" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runAgent(config: AgentConfig, target: RunTarget, deps: EngineDeps): Promise<RunOutcome> {
  const { workspace, vcs } = deps;
  const agent = config.name;
  const prefix = `[${agent}]`;
  let logPath: string | undefined;
  let chain: Promise<void> = Promise.resolve();

  const emit = (level: string, msg: string, extra?: unknown) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra === undefined ? {} : { extra }) });
    (deps.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(`${prefix} ${msg}`);
    if (logPath) {
      const p = logPath;
      chain = chain.then(() => appendFile(p, `${line}\n`).catch(() => undefined));
    }
  };

  /** Appends a backend line to run.log exactly as received. */
  const emitRaw = (raw: string) => {
    (deps.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(`${prefix}[claude] ${raw.trimEnd()}`);
    if (!logPath) return;
    const p = logPath;
    chain = chain.then(() => appendFile(p, raw.endsWith("\n") ? raw : `${raw}\n`).catch(() => undefined));
  };

  let needsSalvage = false;
  let failed = false;
  let baseSha: string | null = null;
  let iterations = 0;
  let salvaged = false;
  const number = target.number;

  try {
    const { env, credential } = buildChildEnv(deps.env ?? process.env, deps.githubToken);
    emit("info", `anthropic credential in use: ${credential}`);

    const workdir = await workspace.clone(target.repo, deps.githubToken);
    logPath = join(workdir, "run.log");
    emit("info", `cloned ${target.repo}`);
    if (target.kind === "pr") {
      const diffPath = await vcs.getPrDiff(target.repo, target.number, workdir);
      emit("info", `diff written to ${diffPath}`);
    }
    baseSha = await workspace.headSha();
    const userMessage = target.kind === "pr" ? buildPrUserMessage(target) : buildUserMessage(target);

    const session = deps.registry.create(config.runner);
    const maxIterations = config.model.max_iterations;
    let sessionId: string | undefined;
    let prompt = userMessage;
    let last: IterationEnd = { kind: "ended" };

    for (let i = 1; i <= maxIterations; i++) {
      iterations = i;
      emit("info", `invoking model=${config.model.name} iteration=${i}/${maxIterations}${sessionId ? ` resume=${sessionId}` : ""}`);
      const running = await session.start({
        systemPrompt: config.system_prompt,
        prompt,
        model: { name: config.model.name, maxTurns: config.model.max_turns },
        cwd: workdir,
        env,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
      });
      last = await consume(running, i, (id) => (sessionId = id));
      if (last.kind === "result") sessionId = last.result.sessionId || sessionId;

      if (last.kind === "result" && last.result.terminalReason === "max_turns" && i < maxIterations) {
        emit("warn", `hit max-turns on iteration ${i}/${maxIterations}; checkpointing and resuming`);
        try {
          await workspace.checkpointCommit(`checkpoint: ${agent} iteration ${i} (max-turns reached)`);
        } catch (err) {
          emit("error", `checkpoint commit failed, not resuming: ${errMsg(err)}`);
          needsSalvage = true;
          break;
        }
        prompt = CONTINUE_PROMPT;
        continue;
      }
      break;
    }

    if (!needsSalvage) {
      if (last.kind !== "result") {
        emit("error", last.kind === "timeout" ? `killed by ${last.reason} timeout` : "produced no result");
        needsSalvage = true;
      } else if (last.result.isError || last.result.terminalReason === "error") {
        emit("error", `finished with an error, terminal_reason=${last.result.terminalReason}`);
        needsSalvage = true;
      } else if (last.result.terminalReason === "max_turns") {
        emit("error", "iterations exhausted while still at max_turns");
        needsSalvage = true;
      } else {
        emit("info", "exited cleanly");
      }
    }

    if (config.output === "review" && target.kind === "pr") {
      await handleReview(target, workdir);
    }
  } catch (err) {
    failed = true;
    needsSalvage = true;
    emit("error", `run failed: ${errMsg(err)}`);
    try {
      await vcs.postComment(
        target.repo,
        number,
        `**Hive agent \`${agent}\` encountered an error.**\n\nThe run failed before completing. Check the container logs for details.\n\n${BOT_MARKER}`,
      );
    } catch {
      emit("warn", "could not post failure comment");
    }
  } finally {
    if (needsSalvage) {
      try {
        salvaged = await salvage();
      } catch (err) {
        emit("error", `salvage attempt failed: ${errMsg(err)}`);
      }
    }
    await chain;
    try {
      await workspace.dispose();
    } catch (err) {
      emit("warn", `workdir cleanup failed: ${errMsg(err)}`);
    }
  }
  return { needsSalvage, salvaged, iterations, failed };

  /** Drains one iteration, enforcing idle and overall timeouts. */
  async function consume(running: RunningSession, iteration: number, onSession: (id: string) => void): Promise<IterationEnd> {
    const idleMs = config.model.idle_timeout * 1000;
    const overallDeadline = Date.now() + config.timeout * 1000;
    const iterator = running.events[Symbol.asyncIterator]();
    let end: IterationEnd = { kind: "ended" };
    let timer: NodeJS.Timeout | undefined;
    try {
      let idleDeadline = Date.now() + idleMs;
      let pending = iterator.next();
      for (;;) {
        const overall = overallDeadline <= idleDeadline;
        const wait = Math.max(0, Math.min(idleDeadline, overallDeadline) - Date.now());
        const timedOut = new Promise<"timeout">((res) => {
          timer = setTimeout(() => res("timeout"), wait);
        });
        const step = await Promise.race([pending, timedOut]);
        clearTimeout(timer);
        if (step === "timeout") {
          const reason = overall ? "overall" : "idle";
          emit("warn", `${reason} timeout exceeded on iteration ${iteration}`);
          try {
            await workspace.checkpointCommit(`checkpoint: ${agent} iteration ${iteration} (${reason} timeout)`);
          } catch (err) {
            emit("warn", `checkpoint before kill failed: ${errMsg(err)}`);
          }
          end = { kind: "timeout", reason };
          break;
        }
        if (step.done) break;
        const ev = step.value;
        idleDeadline = Date.now() + idleMs;
        if (ev.raw !== undefined) {
          emitRaw(ev.raw);
        } else emit("event", ev.type, ev);
        if (ev.type === "session_started") onSession(ev.sessionId);
        else if (ev.type === "result") {
          end = { kind: "result", result: ev };
          break;
        } else if (ev.type === "error") emit("error", ev.message);
        pending = iterator.next();
      }
    } finally {
      clearTimeout(timer);
      await running.close().catch((err: unknown) => emit("warn", `close failed: ${errMsg(err)}`));
      if (running.pid !== undefined) {
        for (let n = 0; n < 20 && isRunning(running.pid); n++) await sleep(50);
        if (isRunning(running.pid)) emit("error", `child pid ${running.pid} still running after close`);
      }
    }
    return end;
  }

  async function salvage(): Promise<boolean> {
    const branch = await workspace.currentBranch();
    if (!branch || branch === "main" || branch === "master") return false;
    const head = await workspace.headSha();
    if (!head || head === baseSha) return false; // nothing new to salvage
    if (!(await workspace.salvage(baseSha))) return false;
    emit("info", `salvaged partial progress, pushed ${branch}`);
    try {
      await vcs.postComment(
        target.repo,
        number,
        `**Hive agent \`${agent}\` did not finish**, but partial progress was pushed to \`${branch}\` before the run ended. Review and continue manually if useful.\n\n${BOT_MARKER}`,
      );
    } catch {
      emit("warn", "could not post salvage comment");
    }
    return true;
  }

  /** Posts review.json, or applies human:review. Never a salvage condition. */
  async function handleReview(pr: Extract<RunTarget, { kind: "pr" }>, workdir: string): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(join(workdir, "review.json"), "utf8"));
      const rec = data as { state?: unknown; body?: unknown } | null;
      if (!rec || typeof rec !== "object" || typeof rec.state !== "string" || typeof rec.body !== "string") {
        throw new Error("review.json is missing required string keys 'state' and 'body'");
      }
      await vcs.postReview(pr.repo, pr.number, rec.body, rec.state);
      emit("info", `review posted for pr=#${pr.number} state=${rec.state}`);
    } catch (err) {
      emit("error", `review not posted for pr=#${pr.number}: ${errMsg(err)}; applying human:review`);
      try {
        await vcs.applyLabel(pr.repo, pr.number, "human:review");
      } catch (labelErr) {
        emit("error", `could not apply human:review: ${errMsg(labelErr)}`);
      }
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
