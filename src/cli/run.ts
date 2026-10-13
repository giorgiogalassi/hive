import { dispatch, ReworkLoop } from "../dispatch/index.js";
import type { DispatchDeps, HiveEvent } from "../dispatch/index.js";
import type { PullRequestSummary } from "../vcs/port.js";
import { orderIssues } from "./order.js";

export interface RunBatchOptions {
  repo: string;
  label: string;
  deps: DispatchDeps;
  /** Injectable so tests do not wait; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollAttempts?: number;
  log?: (line: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `hive run`: processes labelled issues in dependency order. Every agent run goes through `dispatch`
 * with events the webhook would otherwise have produced; the CLI never picks an agent itself.
 * Returns the process exit code.
 */
export async function runBatch(options: RunBatchOptions): Promise<number> {
  const { repo, label } = options;
  const log = options.log ?? ((l: string) => console.log(l));
  const sleep = options.sleep ?? realSleep;
  const interval = options.pollIntervalMs ?? 30_000;
  const attempts = options.pollAttempts ?? 10;
  // One loop state and in-flight set for the whole batch, same classes the webhook path uses.
  const deps: DispatchDeps = {
    ...options.deps,
    loop: options.deps.loop ?? new ReworkLoop(),
    inFlight: options.deps.inFlight ?? new Set<string>(),
  };
  const { vcs } = deps;

  const issues = await vcs.listIssues(repo, label);
  if (issues.length === 0) {
    log(`No open issues found with label '${label}'`);
    return 0;
  }

  const issueMap = new Map(issues.map((i) => [i.number, i]));
  const depMap = new Map<number, number[]>();
  for (const n of [...issueMap.keys()].sort((a, b) => a - b)) {
    try {
      depMap.set(n, await vcs.getIssueDependencies(repo, n));
    } catch (err) {
      log(`[hive run] WARNING: could not read dependencies of #${n}: ${errMsg(err)}. Skipping it.`);
      issueMap.delete(n);
    }
  }

  const { order, stuck } = orderIssues([...issueMap.keys()], depMap);
  if (stuck.length > 0) {
    console.error(`ERROR: Circular dependency detected among issues: [${stuck.join(", ")}]`);
    return 1;
  }

  const findPr = async (n: number): Promise<PullRequestSummary | null> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const prs = await vcs.listOpenPullRequests(repo);
      const pr = prs.find((p) => p.headBranch.startsWith(`agent/issue-${n}-`));
      if (pr) return pr;
      if (attempt < attempts) {
        log(`[hive run] Waiting for PR for issue #${n}... (${attempt}/${attempts})`);
        await sleep(interval);
      }
    }
    return null;
  };

  for (const n of order) {
    log(`[hive run] Processing issue #${n}: ${issueMap.get(n)?.title ?? ""}`);
    try {
      await processIssue(n);
      log(`[hive run] Issue #${n} complete.`);
    } catch (err) {
      log(`[hive run] ERROR: issue #${n} skipped: ${errMsg(err)}`);
    }
  }
  return 0;

  async function processIssue(n: number): Promise<void> {
    await dispatch({ type: "issue_labeled", repo, issueNumber: n, label: "agent:develop" }, deps);

    const pr = await findPr(n);
    if (!pr) {
      log(`[hive run] WARNING: No PR found for issue #${n} after polling. Skipping Reven.`);
      return;
    }

    // Review/rework cycle: ends on approval, human:review, a non-actionable review, or no review posted.
    for (;;) {
      const before = await vcs.getLatestReview(repo, pr.number);
      await dispatch({ type: "pr_labeled", repo, prNumber: pr.number, label: "agent:review" }, deps);
      const after = await vcs.getLatestReview(repo, pr.number);
      if (!after || after.id === before?.id) {
        log(`[hive run] WARNING: Reven posted no new review on PR #${pr.number}.`);
        return;
      }
      const event: HiveEvent = {
        type: "review_submitted",
        repo,
        prNumber: pr.number,
        state: after.state,
        body: after.body,
        author: after.author,
      };
      // dispatch applies the rework loop; in await mode `started` means Cody reworked the PR.
      const result = await dispatch(event, deps);
      if (!result.started) return;
    }
  }
}
