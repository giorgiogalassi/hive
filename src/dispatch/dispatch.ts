import type { AgentConfig } from "../agents/loader.js";
import { runAgent } from "../engine/engine.js";
import type { EngineDeps } from "../engine/engine.js";
import type { RunTarget } from "../engine/types.js";
import { BOT_MARKER } from "../vcs/port.js";
import type { VcsPort } from "../vcs/port.js";
import type { HiveEvent } from "./events.js";
import { ReworkLoop } from "./loop.js";

export type RunMode = "background" | "await";

/** Runs one agent against one target. The only place engine entry points are called is this directory. */
export type EngineRunner = (config: AgentConfig, target: RunTarget) => Promise<unknown>;

export interface DispatchDeps {
  vcs: VcsPort;
  loadAgent: (name: string) => AgentConfig;
  engine: EngineRunner;
  runMode: RunMode;
  /** Repo owner whose PR comments requeue cody. Defaults to GITHUB_OWNER; empty matches nobody. */
  owner?: string;
  /** Rework-loop state; share one instance across dispatch calls. Defaults to a module-level instance. */
  loop?: ReworkLoop;
  /** In-flight keys; share across calls. Defaults to a module-level set. */
  inFlight?: Set<string>;
  log?: (line: string) => void;
}

export interface DispatchResult {
  /** True when an agent run was started (or finished, in await mode). */
  started: boolean;
}

const defaultLoop = new ReworkLoop();
const defaultInFlight = new Set<string>();

/** Adapts runAgent to the EngineRunner shape. */
export function engineRunner(engineDeps: EngineDeps): EngineRunner {
  return (config, target) => runAgent(config, target, engineDeps);
}

const ISSUE_AGENTS: Record<string, string> = {
  "agent:analyze": "issue-reviewer",
  "agent:develop": "cody",
};

export async function dispatch(event: HiveEvent, deps: DispatchDeps): Promise<DispatchResult> {
  const log = deps.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const loop = deps.loop ?? defaultLoop;
  const owner = deps.owner ?? process.env.GITHUB_OWNER ?? "";
  const ignored: DispatchResult = { started: false };

  const details = async (repo: string, n: number) => {
    try {
      const i = await deps.vcs.getIssue(repo, n);
      return { title: i.title ?? "", body: i.body ?? "" };
    } catch (err) {
      log(`[dispatch] could not fetch ${repo}#${n}: ${err instanceof Error ? err.message : String(err)}`);
      return { title: "", body: "" };
    }
  };

  /** Builds a PR target from freshly fetched PR details; empty values (logged) when the fetch fails. */
  const prTarget = async (repo: string, n: number, reviewBody = ""): Promise<RunTarget> => {
    let pr = { title: "", body: "", headBranch: "", baseBranch: "" };
    try {
      pr = await deps.vcs.getPullRequest(repo, n);
    } catch (err) {
      log(`[dispatch] could not fetch PR ${repo}#${n}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      kind: "pr",
      repo,
      number: n,
      title: pr.title,
      body: pr.body,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      reviewBody,
    };
  };

  const isInFlight = (agentName: string, repo: string, n: number): boolean =>
    (deps.inFlight ?? defaultInFlight).has(`${repo}#${n}#${agentName}`);

  const escalate = async (repo: string, n: number): Promise<void> => {
    try {
      await deps.vcs.applyLabel(repo, n, "human:review");
    } catch (err) {
      log(`[dispatch] could not apply human:review: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Claims the in-flight key, builds the target, runs the agent; releases the key when the run ends. */
  const start = async (
    agentName: string,
    repo: string,
    n: number,
    makeTarget: () => Promise<RunTarget>,
  ): Promise<DispatchResult> => {
    const inFlight = deps.inFlight ?? defaultInFlight;
    const key = `${repo}#${n}#${agentName}`;
    if (inFlight.has(key)) {
      log(`[dispatch] dropped ${agentName} trigger for ${repo}#${n}: run already in flight`);
      return ignored;
    }
    inFlight.add(key);
    const run = (async () => {
      try {
        const config = deps.loadAgent(agentName);
        const target = await makeTarget();
        log(`[dispatch] starting ${agentName} for ${repo}#${n}`);
        await deps.engine(config, target);
      } finally {
        inFlight.delete(key);
      }
    })();
    if (deps.runMode === "await") {
      await run;
    } else {
      run.catch((err: unknown) =>
        log(`[dispatch] ${agentName} run for ${repo}#${n} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    return { started: true };
  };

  switch (event.type) {
    case "issue_labeled": {
      const agent = ISSUE_AGENTS[event.label];
      if (!agent) {
        log(`[dispatch] debug: unhandled label ${event.label}, ignoring`);
        return ignored;
      }
      return start(agent, event.repo, event.issueNumber, async () => {
        const d = await details(event.repo, event.issueNumber);
        return { kind: "issue", repo: event.repo, number: event.issueNumber, ...d };
      });
    }
    case "pr_opened": {
      try {
        if (await deps.vcs.hasLabel(event.repo, event.prNumber, "agent:review")) {
          log(`[dispatch] debug: agent:review already present on ${event.repo}#${event.prNumber}`);
        } else {
          await deps.vcs.applyLabel(event.repo, event.prNumber, "agent:review");
        }
      } catch (err) {
        log(`[dispatch] could not label ${event.repo}#${event.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ignored;
    }
    case "pr_labeled": {
      if (event.label !== "agent:review") {
        log(`[dispatch] debug: unhandled label ${event.label}, ignoring`);
        return ignored;
      }
      return start("reven", event.repo, event.prNumber, () => prTarget(event.repo, event.prNumber));
    }
    case "review_submitted": {
      // A trigger that will be dropped as in-flight must not consume a rework slot.
      if (event.state === "changes_requested" && isInFlight("cody", event.repo, event.prNumber)) {
        log(`[dispatch] dropped cody trigger for ${event.repo}#${event.prNumber}: run already in flight`);
        return ignored;
      }
      const decision = loop.onReview(event.repo, event.prNumber, event.state);
      if (decision === "human_review") {
        await escalate(event.repo, event.prNumber);
        return ignored;
      }
      if (decision !== "requeue") {
        log(`[dispatch] debug: review ${event.state} on ${event.repo}#${event.prNumber} -> ${decision}`);
        return ignored;
      }
      return start("cody", event.repo, event.prNumber, () => prTarget(event.repo, event.prNumber, event.body));
    }
    case "pr_comment": {
      if (event.body.includes(BOT_MARKER)) {
        log(`[dispatch] debug: ignoring Hive-authored comment on ${event.repo}#${event.prNumber}`);
        return ignored;
      }
      if (owner === "" || event.author !== owner) {
        log(`[dispatch] debug: comment author ${event.author} is not the repo owner, ignoring`);
        return ignored;
      }
      if (isInFlight("cody", event.repo, event.prNumber)) {
        log(`[dispatch] dropped cody trigger for ${event.repo}#${event.prNumber}: run already in flight`);
        return ignored;
      }
      const decision = loop.onOwnerComment(event.repo, event.prNumber);
      if (decision === "human_review") {
        await escalate(event.repo, event.prNumber);
        return ignored;
      }
      if (decision !== "requeue") {
        log(`[dispatch] debug: owner comment on ${event.repo}#${event.prNumber} before first review, ignoring`);
        return ignored;
      }
      return start("cody", event.repo, event.prNumber, () => prTarget(event.repo, event.prNumber, event.body));
    }
  }
}
