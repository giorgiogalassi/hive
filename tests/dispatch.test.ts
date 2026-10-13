import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents/loader.js";
import { ReworkLoop, dispatch, toHiveEvent } from "../src/dispatch/index.js";
import type { DispatchDeps, HiveEvent } from "../src/dispatch/index.js";
import type { RunTarget } from "../src/engine/types.js";
import type { VcsPort } from "../src/vcs/port.js";

function setup(over: Partial<DispatchDeps> = {}, hasLabel = false) {
  const labels: string[] = [];
  const runs: { agent: string; target: RunTarget }[] = [];
  const logs: string[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  const vcs = {
    getIssue: async () => ({ number: 1, title: "T", body: "B" }),
    hasLabel: async () => hasLabel,
    applyLabel: async (_r: string, n: number, l: string) => void labels.push(`${n}:${l}`),
  } as unknown as VcsPort;
  const deps: DispatchDeps = {
    vcs,
    loadAgent: (name) => ({ name }) as AgentConfig,
    engine: async (config, target) => {
      runs.push({ agent: config.name, target });
      if (hold) await new Promise<void>((r) => gates.push(r));
    },
    runMode: "await",
    owner: "owner",
    loop: new ReworkLoop(),
    inFlight: new Set(),
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, labels, runs, logs, gates, holdRuns: () => (hold = true) };
}

const review = (state: "approved" | "changes_requested" | "commented"): HiveEvent => ({
  type: "review_submitted", repo: "o/r", prNumber: 5, state, body: "fix it", author: "bot",
});
const comment = (author: string): HiveEvent => ({ type: "pr_comment", repo: "o/r", prNumber: 5, body: "pls", author });

describe("dispatch", () => {
  it("only src/dispatch calls engine run entry points", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /\brunAgent\(/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("src");
    expect(hits.filter((p) => !p.includes("src/dispatch/") && !p.endsWith("src/engine/engine.ts"))).toEqual([]);
  });

  it("changes_requested x3 requeues cody, the fourth escalates to human:review", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await dispatch(review("changes_requested"), t.deps);
    expect(t.runs.map((r) => r.agent)).toEqual(["cody", "cody", "cody"]);
    expect(t.runs[0]?.target).toMatchObject({ kind: "pr", reviewBody: "fix it" });
    expect(t.labels).toEqual([]);
    const res = await dispatch(review("changes_requested"), t.deps);
    expect(res.started).toBe(false);
    expect(t.runs).toHaveLength(3);
    expect(t.labels).toEqual(["5:human:review"]);
  });

  it("ignores commented reviews", async () => {
    const t = setup();
    await dispatch(review("commented"), t.deps);
    expect(t.runs).toHaveLength(0);
  });

  it("owner comment is ignored before a review, requeues after; non-owner never runs", async () => {
    const t = setup();
    await dispatch(comment("owner"), t.deps);
    expect(t.runs).toHaveLength(0);
    await dispatch(review("approved"), t.deps);
    await dispatch(comment("stranger"), t.deps);
    expect(t.runs).toHaveLength(0);
    await dispatch(comment("owner"), t.deps);
    expect(t.runs).toHaveLength(1);
    expect(t.deps.loop?.get("o/r", 5).codyRuns).toBe(1);
  });

  it("drops a duplicate in-flight trigger and allows a new one after completion", async () => {
    const t = setup({ runMode: "background" });
    t.holdRuns();
    const ev: HiveEvent = { type: "issue_labeled", repo: "o/r", issueNumber: 7, label: "agent:develop" };
    await dispatch(ev, t.deps);
    await dispatch(ev, t.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.runs).toHaveLength(1);
    expect(t.logs.filter((l) => l.includes("dropped"))).toHaveLength(1);
    t.gates.forEach((g) => g());
    await new Promise((r) => setTimeout(r, 0));
    await dispatch(ev, t.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.runs).toHaveLength(2);
  });

  it("pr_opened with agent:review present touches neither applyLabel nor the engine", async () => {
    const t = setup({}, true);
    await dispatch({ type: "pr_opened", repo: "o/r", prNumber: 5, title: "x", headBranch: "h", baseBranch: "b", author: "a" }, t.deps);
    expect(t.labels).toEqual([]);
    expect(t.runs).toHaveLength(0);
  });

  it("pr_opened without the label applies it and starts no run", async () => {
    const t = setup();
    await dispatch({ type: "pr_opened", repo: "o/r", prNumber: 5, title: "x", headBranch: "h", baseBranch: "b", author: "a" }, t.deps);
    expect(t.labels).toEqual(["5:agent:review"]);
    expect(t.runs).toHaveLength(0);
  });

  it("maps labels to agents and ignores unknown ones", async () => {
    const t = setup();
    await dispatch({ type: "issue_labeled", repo: "o/r", issueNumber: 1, label: "agent:analyze" }, t.deps);
    await dispatch({ type: "issue_labeled", repo: "o/r", issueNumber: 2, label: "bug" }, t.deps);
    await dispatch({ type: "pr_labeled", repo: "o/r", prNumber: 3, label: "agent:review" }, t.deps);
    expect(t.runs.map((r) => r.agent)).toEqual(["issue-reviewer", "reven"]);
    expect(t.runs[0]?.target).toMatchObject({ kind: "issue", title: "T", body: "B" });
  });

  it("uses empty title/body when getIssue fails", async () => {
    const t = setup();
    (t.deps.vcs as unknown as { getIssue: () => Promise<never> }).getIssue = async () => {
      throw new Error("boom");
    };
    await dispatch({ type: "issue_labeled", repo: "o/r", issueNumber: 1, label: "agent:develop" }, t.deps);
    expect(t.runs[0]?.target).toMatchObject({ title: "", body: "" });
  });
});

describe("toHiveEvent", () => {
  it("maps normalized events and drops non-PR comments", () => {
    expect(toHiveEvent({ type: "issue_comment", repo: "r", number: 2, body: "b", author: "a", isPr: true })).toEqual({
      type: "pr_comment", repo: "r", prNumber: 2, body: "b", author: "a",
    });
    expect(toHiveEvent({ type: "issue_comment", repo: "r", number: 2, body: "b", author: "a", isPr: false })).toBeNull();
    expect(toHiveEvent({ type: "pr_review_submitted", repo: "r", prNumber: 2, state: "approved", body: "", author: "a" })?.type).toBe("review_submitted");
  });
});
