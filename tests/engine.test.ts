import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents/loader.js";
import { BackendRegistry, runAgent } from "../src/engine/index.js";
import type { AgentEvent, AgentSession, RunTarget, SessionRequest, WorkspacePort } from "../src/engine/index.js";
import { BOT_MARKER, VcsHttpError } from "../src/vcs/port.js";
import type { VcsPort } from "../src/vcs/port.js";

const ev = {
  result: (sessionId: string, terminalReason: "completed" | "max_turns" | "error", isError = false): AgentEvent => ({
    schemaVersion: 1,
    type: "result",
    sessionId,
    terminalReason,
    isError,
    payload: {},
  }),
};

function config(over: Partial<AgentConfig> = {}, model: Partial<AgentConfig["model"]> = {}): AgentConfig {
  return {
    name: "cody",
    description: "",
    runner: "claude-code",
    model: { provider: "anthropic", name: "m", max_turns: 5, max_iterations: 3, idle_timeout: 60, ...model },
    timeout: 60,
    triggers: [],
    system_prompt: "sys",
    ...over,
  };
}

class FakeWorkspace implements WorkspacePort {
  dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  branch = "feature";
  head = "base";
  commits: string[] = [];
  salvages = 0;
  disposed = false;
  failCheckpoint = false;
  async clone() {
    return this.dir;
  }
  async headSha() {
    return this.head;
  }
  async currentBranch() {
    return this.branch;
  }
  async checkpointCommit(message: string) {
    if (this.failCheckpoint) throw new Error("commit failed");
    this.commits.push(message);
    this.head = `sha${this.commits.length}`;
  }
  async salvage() {
    this.salvages++;
    return true;
  }
  async dispose() {
    this.disposed = true;
  }
}

class FakeVcs {
  comments: string[] = [];
  labels: string[] = [];
  reviews: unknown[][] = [];
  reviewError: Error | undefined;
  async postComment(_r: string, _n: number, body: string) {
    this.comments.push(body);
  }
  async applyLabel(_r: string, _n: number, label: string) {
    this.labels.push(label);
  }
  async postReview(...args: unknown[]) {
    if (this.reviewError) throw this.reviewError;
    this.reviews.push(args);
  }
  async getPrDiff(_r: string, _n: number, workdir: string) {
    return join(workdir, "diff.patch");
  }
}

function fakeSession(scripts: AgentEvent[][] | "silent") {
  const requests: SessionRequest[] = [];
  let closed = 0;
  let release: (() => void) | undefined;
  const session: AgentSession = {
    async start(req) {
      requests.push(req);
      const idx = requests.length - 1;
      return {
        events: (async function* () {
          if (scripts === "silent") {
            await new Promise<void>((r) => (release = r));
            return;
          }
          for (const e of scripts[idx] ?? []) yield e;
        })(),
        async close() {
          closed++;
          release?.();
        },
      };
    },
  };
  return { session, requests, closed: () => closed };
}

function setup(session: AgentSession, ws = new FakeWorkspace(), vcs = new FakeVcs(), env: Record<string, string> = {}) {
  const registry = new BackendRegistry().register("claude-code", () => session);
  const deps = { registry, workspace: ws, vcs: vcs as unknown as VcsPort, githubToken: "gh", env, log: () => undefined };
  return { ws, vcs, deps };
}

const issue: RunTarget = { kind: "issue", repo: "o/r", number: 7, title: "T", body: "B" };
const pr: RunTarget = { kind: "pr", repo: "o/r", number: 9, title: "T", body: "B", headBranch: "h", baseBranch: "b" };

describe("engine", () => {
  it("checkpoints twice and resumes the same session across 3 iterations", async () => {
    const f = fakeSession([
      [ev.result("s1", "max_turns")],
      [ev.result("s1", "max_turns")],
      [ev.result("s1", "completed")],
    ]);
    const { ws, deps } = setup(f.session);
    const out = await runAgent(config(), issue, deps);
    expect(ws.commits).toEqual([
      "checkpoint: cody iteration 1 (max-turns reached)",
      "checkpoint: cody iteration 2 (max-turns reached)",
    ]);
    expect(f.requests.map((r) => r.resumeSessionId)).toEqual([undefined, "s1", "s1"]);
    expect(f.requests[1]?.prompt).toBe("Continue exactly where you left off. Do not repeat completed work.");
    expect(out.needsSalvage).toBe(false);
    expect(ws.disposed).toBe(true);
  });

  it("ends a silent iteration on idle_timeout, closes, and salvages", async () => {
    const f = fakeSession("silent");
    const { ws, deps } = setup(f.session);
    ws.head = "base";
    const started = Date.now();
    const out = await runAgent(config({}, { idle_timeout: 1 }), issue, deps);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.closed()).toBe(1);
    expect(out.needsSalvage).toBe(true);
    expect(ws.commits[0]).toContain("idle timeout");
    expect(ws.salvages).toBe(1); // checkpoint moved HEAD past base
  });

  it("does not resume when the checkpoint commit fails", async () => {
    const f = fakeSession([[ev.result("s1", "max_turns")], [ev.result("s1", "completed")]]);
    const ws = new FakeWorkspace();
    ws.failCheckpoint = true;
    const { deps } = setup(f.session, ws);
    const out = await runAgent(config(), issue, deps);
    expect(f.requests).toHaveLength(1);
    expect(out.needsSalvage).toBe(true);
  });

  it("skips salvage on main or when HEAD equals the base SHA, otherwise salvages", async () => {
    const run = async (branch: string, advance: boolean) => {
      const f = fakeSession([[ev.result("s", "error", true)]]);
      const ws = new FakeWorkspace();
      ws.branch = branch;
      const { deps, vcs } = setup(f.session, ws);
      const origHead = ws.headSha.bind(ws);
      let calls = 0;
      ws.headSha = async () => (calls++ === 0 ? origHead() : advance ? "new" : "base");
      const out = await runAgent(config(), issue, deps);
      return { ws, vcs, out };
    };
    const onMain = await run("main", true);
    expect(onMain.ws.salvages).toBe(0);
    const same = await run("feature", false);
    expect(same.ws.salvages).toBe(0);
    const pushed = await run("feature", true);
    expect(pushed.ws.salvages).toBe(1);
    expect(pushed.out.salvaged).toBe(true);
    expect(pushed.vcs.comments[0]).toContain("partial progress");
    expect(pushed.vcs.comments[0]).toContain(BOT_MARKER);
  });

  it("marks the failure comment with the bot marker", async () => {
    const session: AgentSession = {
      async start() {
        throw new Error("backend down");
      },
    };
    const { deps, vcs } = setup(session);
    await runAgent(config(), issue, deps);
    expect(vcs.comments).toHaveLength(1);
    expect(vcs.comments[0]).toContain("encountered an error");
    expect(vcs.comments[0]).toContain(BOT_MARKER);
  });

  it("applies human:review without salvage when postReview throws an HTTP error", async () => {
    const f = fakeSession([[ev.result("s", "completed")]]);
    const { ws, vcs, deps } = setup(f.session);
    writeFileSync(join(ws.dir, "review.json"), JSON.stringify({ state: "approved", body: "ok" }));
    vcs.reviewError = new VcsHttpError(422, "bad");
    const out = await runAgent(config({ output: "review" }), pr, deps);
    expect(vcs.labels).toEqual(["human:review"]);
    expect(out.needsSalvage).toBe(false);
    expect(ws.salvages).toBe(0);
  });

  it("posts the review when review.json is valid, and labels when absent", async () => {
    const f = fakeSession([[ev.result("s", "completed")]]);
    const a = setup(f.session);
    writeFileSync(join(a.ws.dir, "review.json"), JSON.stringify({ state: "approved", body: "ok" }));
    await runAgent(config({ output: "review" }), pr, a.deps);
    expect(a.vcs.reviews).toEqual([["o/r", 9, "ok", "approved"]]);

    const f2 = fakeSession([[ev.result("s", "completed")]]);
    const b = setup(f2.session);
    await runAgent(config({ output: "review" }), pr, b.deps);
    expect(b.vcs.labels).toEqual(["human:review"]);
  });

  it("hands exactly one Anthropic credential to the session", async () => {
    const f = fakeSession([[ev.result("s", "completed")]]);
    const { deps } = setup(f.session, undefined, undefined, {
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
    });
    await runAgent(config(), issue, deps);
    const env = f.requests[0]?.env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect(env.GITHUB_TOKEN).toBe("gh");
  });

  it("posts a failure comment when the backend throws", async () => {
    const session: AgentSession = {
      async start() {
        throw new Error("boom");
      },
    };
    const { vcs, deps } = setup(session);
    const out = await runAgent(config(), issue, deps);
    expect(out.failed).toBe(true);
    expect(vcs.comments[0]).toContain("encountered an error");
  });
});
