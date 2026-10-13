import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agents/loader.js";
import { loadLayeredEnv, parseDotenv } from "../src/cli/env.js";
import { orderIssues } from "../src/cli/order.js";
import { parseRemoteUrl, resolveRepo } from "../src/cli/repo.js";
import { runBatch } from "../src/cli/run.js";
import type { DispatchDeps } from "../src/dispatch/index.js";
import type { PullRequestSummary, SubmittedReview, VcsPort } from "../src/vcs/port.js";

interface Scenario {
  issues: number[];
  deps?: Record<number, number[]>;
  /** Review states Reven posts, per PR number, in order; the last repeats. */
  reviews?: Record<number, ("approved" | "changes_requested" | "commented")[]>;
  prAfterPolls?: number;
  noPr?: number[];
  failIssue?: number;
}

function setup(sc: Scenario) {
  const runs: string[] = [];
  const labels: string[] = [];
  const logs: string[] = [];
  const latest = new Map<number, SubmittedReview>();
  const reviewCount = new Map<number, number>();
  let polls = 0;
  const pr = (n: number): PullRequestSummary => ({
    number: 100 + n, title: "t", headBranch: `agent/issue-${n}-x`, baseBranch: "main", author: "bot",
  });
  const vcs = {
    listIssues: async () => sc.issues.map((number) => ({ number, title: `i${number}`, body: "" })),
    getIssueDependencies: async (_r: string, n: number) => sc.deps?.[n] ?? [],
    getIssue: async (_r: string, n: number) => ({ number: n, title: "T", body: "B" }),
    listOpenPullRequests: async () => {
      polls += 1;
      if (sc.failIssue !== undefined && runs.includes(`cody:${sc.failIssue}`) && !runs.some((r) => r.startsWith(`cody:`) && r !== `cody:${sc.failIssue}`) ) {
        throw new Error("HTTP 500");
      }
      if (polls <= (sc.prAfterPolls ?? 0)) return [];
      return sc.issues.filter((n) => !sc.noPr?.includes(n)).map(pr);
    },
    getLatestReview: async (_r: string, n: number) => latest.get(n) ?? null,
    applyLabel: async (_r: string, n: number, l: string) => void labels.push(`${n}:${l}`),
    hasLabel: async () => false,
  } as unknown as VcsPort;
  const deps: DispatchDeps = {
    vcs,
    loadAgent: (name) => ({ name }) as AgentConfig,
    engine: async (config, target) => {
      runs.push(`${config.name}:${target.number}`);
      if (config.name === "reven") {
        const seq = sc.reviews?.[target.number] ?? ["approved"];
        const i = reviewCount.get(target.number) ?? 0;
        reviewCount.set(target.number, i + 1);
        latest.set(target.number, {
          id: i + 1, state: seq[Math.min(i, seq.length - 1)] ?? "approved", body: "b", author: "reven",
        });
      }
    },
    runMode: "await",
    owner: "owner",
    log: (l) => logs.push(l),
  };
  const sleeps: number[] = [];
  const run = () =>
    runBatch({ repo: "o/r", label: "proj", deps, sleep: async (ms) => void sleeps.push(ms), log: (l) => logs.push(l) });
  return { run, runs, labels, logs, sleeps, getPolls: () => polls };
}

describe("orderIssues", () => {
  it("orders dependencies first and independents by ascending number", () => {
    const r = orderIssues([5, 3, 4, 1], new Map([[1, [5]], [3, []]]));
    expect(r).toEqual({ order: [3, 4, 5, 1], stuck: [] });
  });
  it("ignores dependencies outside the set and treats missing metadata as independent", () => {
    expect(orderIssues([9, 2], new Map([[9, [77]]])).order).toEqual([2, 9]);
  });
  it("reports stuck issues on a cycle", () => {
    expect(orderIssues([1, 2, 3], new Map([[1, [2]], [2, [1]]]))).toEqual({ order: [3], stuck: [1, 2] });
  });
});

describe("runBatch", () => {
  it("runs cody then reven per issue in dependency order", async () => {
    const t = setup({ issues: [1, 2, 3], deps: { 1: [3] } });
    expect(await t.run()).toBe(0);
    expect(t.runs).toEqual(["cody:2", "reven:102", "cody:3", "reven:103", "cody:1", "reven:101"]);
  });

  it("aborts with a non-zero exit before any run on a cycle", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup({ issues: [1, 2], deps: { 1: [2], 2: [1] } });
    expect(await t.run()).toBe(1);
    expect(t.runs).toEqual([]);
    expect(err.mock.calls[0]?.[0]).toContain("[1, 2]");
    err.mockRestore();
  });

  it("polls 10 times at 30 s, then warns and continues to the next issue", async () => {
    const t = setup({ issues: [1, 2], noPr: [1] });
    expect(await t.run()).toBe(0);
    expect(t.runs).toEqual(["cody:1", "cody:2", "reven:102"]);
    expect(t.sleeps).toHaveLength(9);
    expect(new Set(t.sleeps)).toEqual(new Set([30_000]));
    expect(t.logs.some((l) => l.includes("WARNING: No PR found for issue #1"))).toBe(true);
  });

  it("waits for the PR to appear", async () => {
    const t = setup({ issues: [1], prAfterPolls: 3 });
    await t.run();
    expect(t.sleeps).toHaveLength(3);
    expect(t.runs).toEqual(["cody:1", "reven:101"]);
  });

  it("requeues cody through the rework loop on REQUEST_CHANGES until approved", async () => {
    const t = setup({ issues: [1], reviews: { 101: ["changes_requested", "changes_requested", "approved"] } });
    await t.run();
    expect(t.runs).toEqual(["cody:1", "reven:101", "cody:101", "reven:101", "cody:101", "reven:101"]);
    expect(t.labels).toEqual([]);
  });

  it("caps cody runs at 3 and applies human:review", async () => {
    const t = setup({ issues: [1], reviews: { 101: ["changes_requested"] } });
    await t.run();
    expect(t.runs.filter((r) => r === "cody:101")).toHaveLength(3);
    expect(t.runs.filter((r) => r === "reven:101")).toHaveLength(4);
    expect(t.labels).toEqual(["101:human:review"]);
  });

  it("stops when reven posts no new review", async () => {
    const t = setup({ issues: [1], reviews: { 101: ["approved"] } });
    await t.run();
    expect(t.runs).toEqual(["cody:1", "reven:101"]);
  });

  it("logs and skips an issue whose VCS call fails, then continues", async () => {
    const t = setup({ issues: [1, 2], failIssue: 1 });
    expect(await t.run()).toBe(0);
    expect(t.logs.some((l) => l.includes("issue #1 skipped: HTTP 500"))).toBe(true);
    expect(t.runs).toContain("cody:2");
  });
});

describe("env layering", () => {
  it("process env > ./.env > ~/.hive/.env", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-env-"));
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    mkdirSync(join(home, ".hive"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, ".hive", ".env"), "A=home\nB=home\nC=home\n");
    writeFileSync(join(cwd, ".env"), "A=cwd\nB=cwd\n");
    const env = loadLayeredEnv({ env: { A: "proc" }, cwd, home });
    expect(env["A"]).toBe("proc");
    expect(env["B"]).toBe("cwd");
    expect(env["C"]).toBe("home");
  });

  it("tolerates missing files and parses like the Python version", () => {
    expect(loadLayeredEnv({ env: {}, cwd: "/nonexistent-x", home: "/nonexistent-y" })).toEqual({});
    expect(parseDotenv("# c\nexport K1=\"v 1\"\nK2='x'\nK3=a#b\nbad\n=nokey\n")).toEqual({
      K1: "v 1", K2: "x", K3: "a#b",
    });
  });
});

describe("repo resolution", () => {
  it("prefers --repo, then GITHUB_REPO, then origin", () => {
    const detect = () => "o/origin";
    expect(resolveRepo("o/flag", { GITHUB_REPO: "o/env" }, detect)).toBe("o/flag");
    expect(resolveRepo(undefined, { GITHUB_REPO: "o/env" }, detect)).toBe("o/env");
    expect(resolveRepo(undefined, {}, detect)).toBe("o/origin");
    expect(resolveRepo(undefined, {}, () => "")).toBe("");
  });

  it("parses https and ssh remotes", () => {
    expect(parseRemoteUrl("https://github.com/o/r.git")).toBe("o/r");
    expect(parseRemoteUrl("git@github.com:o/r.git\n")).toBe("o/r");
    expect(parseRemoteUrl("https://github.com/o/r")).toBe("o/r");
    expect(parseRemoteUrl("nonsense")).toBe("");
  });
});
