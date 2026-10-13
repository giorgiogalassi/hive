import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents/loader.js";
import { ClaudeCodeSession, buildArgs, registerClaudeCode } from "../src/backends/index.js";
import { BackendRegistry, runAgent } from "../src/engine/index.js";
import type { AgentEvent, SessionRequest, WorkspacePort } from "../src/engine/index.js";
import type { VcsPort } from "../src/vcs/port.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function req(mode: string, extra: Partial<SessionRequest> = {}): { request: SessionRequest; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-test-"));
  const out = join(dir, "calls.ndjson");
  return {
    out,
    request: {
      systemPrompt: "SYS",
      prompt: "hello",
      model: { name: "m", maxTurns: 7 },
      cwd: dir,
      env: { ...(process.env as Record<string, string>), FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_OUT: out },
      ...extra,
    },
  };
}

async function collect(session: ClaudeCodeSession, request: SessionRequest) {
  const running = await session.start(request);
  const events: AgentEvent[] = [];
  for await (const e of running.events) events.push(e);
  await running.close();
  return { events, running };
}

const records = (out: string) =>
  readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; stdinLength?: number; grandchild?: number });

describe("claude-code backend", () => {
  const session = new ClaudeCodeSession({ command: fake, killGraceMs: 300 });

  it("builds the documented command line", () => {
    const { request } = req("complete", { resumeSessionId: "abc" });
    expect(buildArgs(request)).toEqual([
      "--print", "--dangerously-skip-permissions", "--model", "m", "--max-turns", "7",
      "--output-format", "stream-json", "--verbose", "--system-prompt", "SYS", "-p", "-", "--resume", "abc",
    ]);
  });

  it("maps NDJSON lines to events and keeps raw lines", async () => {
    const { request } = req("complete");
    const { events } = await collect(session, request);
    // stderr arrives on its own pipe, so its position relative to stdout lines is not fixed.
    expect(events.map((e) => e.type).sort()).toEqual(["activity", "activity", "activity", "result", "session_started"]);
    expect(events[0]).toMatchObject({ type: "session_started", sessionId: "sess-1" });
    expect(events).toContainEqual(expect.objectContaining({ payload: { unparsed: "not json at all" }, raw: "not json at all" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "result", terminalReason: "completed", isError: false, sessionId: "sess-1" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "activity", payload: { unparsed: "warning on stderr" } }));
  });

  it.each(["max_turns", "subtype_only"])("maps %s to terminalReason max_turns", async (mode) => {
    const { events } = await collect(session, req(mode).request);
    expect(events.find((e) => e.type === "result")).toMatchObject({ terminalReason: "max_turns", isError: true });
  });

  it("emits an error event on non-zero exit without a result", async () => {
    const { events } = await collect(session, req("crash").request);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
  });

  it("emits an error event when the command cannot be started", async () => {
    const { events } = await collect(new ClaudeCodeSession({ command: "/nonexistent/claude" }), req("complete").request);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("delivers a large prompt without deadlocking", async () => {
    const { request, out } = req("complete", { prompt: "x".repeat(2_000_000) });
    await collect(session, request);
    expect(records(out)[0]?.stdinLength).toBe(2_000_000);
  });

  for (const mode of ["hang", "hang_ignore_term"]) {
    it(`close() kills the process tree (${mode}) and the pid is gone`, async () => {
      const { request, out } = req(mode);
      const running = await session.start(request);
      const it = running.events[Symbol.asyncIterator]();
      await it.next(); // session_started: child is up
      const pid = running.pid;
      expect(pid).toBeTypeOf("number");
      expect(isRunning(pid as number)).toBe(true);
      for (let n = 0; n < 100 && !records(out).some((r) => r.grandchild); n++) await new Promise((r) => setTimeout(r, 20));
      const grandchild = records(out).find((r) => r.grandchild)?.grandchild as number;
      await running.close();
      expect(isRunning(pid as number)).toBe(false);
      expect(isRunning(grandchild)).toBe(false);
    });
  }
});

describe("claude-code through the engine", () => {
  it("resumes with the same session id after max_turns and logs raw NDJSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-engine-"));
    const out = join(dir, "calls.ndjson");
    const ws = {
      async clone() { return dir; },
      async headSha() { return "base"; },
      async currentBranch() { return "feature"; },
      async checkpointCommit() { return; },
      async salvage() { return false; },
      async dispose() { return; },
    } satisfies WorkspacePort;
    const registry = registerClaudeCode(new BackendRegistry(), { command: fake });
    const config: AgentConfig = {
      name: "cody", description: "", runner: "claude-code",
      model: { provider: "anthropic", name: "m", max_turns: 5, max_iterations: 2, idle_timeout: 30 },
      timeout: 60, triggers: [], system_prompt: "sys",
    };
    const env = { ...(process.env as Record<string, string>), FAKE_CLAUDE_MODE: "max_turns", FAKE_CLAUDE_OUT: out, FAKE_CLAUDE_SESSION: "sess-xyz" };
    const outcome = await runAgent(config, { kind: "issue", repo: "o/r", number: 1, title: "T", body: "B" }, {
      registry, workspace: ws, vcs: {} as unknown as VcsPort, githubToken: "gh", env, log: () => undefined,
    });
    const calls = records(out).filter((r) => r.argv);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.argv).not.toContain("--resume");
    expect(calls[1]?.argv?.slice(-2)).toEqual(["--resume", "sess-xyz"]);
    expect(outcome.iterations).toBe(2);
    const log = readFileSync(join(dir, "run.log"), "utf8").split("\n");
    expect(log).toContain('{"type":"system","subtype":"init","session_id":"sess-xyz"}');
    expect(log).toContain("not json at all");
  });
});
