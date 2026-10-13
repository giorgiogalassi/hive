import { loadAgent } from "../agents/loader.js";
import { registerClaudeCode } from "../backends/claude-code/index.js";
import { engineRunner } from "../dispatch/dispatch.js";
import type { DispatchDeps, RunMode } from "../dispatch/dispatch.js";
import { buildChildEnv } from "../engine/env.js";
import type { CredentialKind } from "../engine/env.js";
import { BackendRegistry } from "../engine/registry.js";
import { GitHubAdapter } from "../vcs/github-adapter.js";
import { GitWorkspace } from "../workspace/git-workspace.js";

export interface CreateDispatchDepsOptions {
  /** `background` for the webhook, `await` for `hive run`. */
  runMode: RunMode;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/** Which Anthropic credential the engine will hand to agents (same resolution as the engine). */
export function resolveCredentialKind(env: Record<string, string | undefined> = process.env): CredentialKind {
  return buildChildEnv(env, "").credential;
}

/**
 * Builds the real DispatchDeps shared by the webhook and `hive run`.
 * Each run gets its own GitWorkspace: a workspace holds one temp clone, and runs execute concurrently.
 */
export function createDispatchDeps(options: CreateDispatchDepsOptions): DispatchDeps {
  const env = options.env ?? process.env;
  const vcs = new GitHubAdapter();
  const registry = registerClaudeCode(new BackendRegistry());
  const githubToken = env["GITHUB_TOKEN"] ?? "";
  return {
    vcs,
    loadAgent: (name) => loadAgent(name),
    engine: (config, target) =>
      engineRunner({
        registry,
        workspace: new GitWorkspace(config.name),
        vcs,
        githubToken,
        env,
        ...(options.log ? { log: options.log } : {}),
      })(config, target),
    runMode: options.runMode,
    ...(options.log ? { log: options.log } : {}),
  };
}
