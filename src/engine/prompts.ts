import type { RunTarget } from "./types.js";

export const CONTINUE_PROMPT = "Continue exactly where you left off. Do not repeat completed work.";

export function buildUserMessage(target: Extract<RunTarget, { kind: "issue" }>): string {
  return (
    `Repository: ${target.repo}\n` +
    `Issue #${target.number}: ${target.title}\n\n` +
    `${target.body}\n\n` +
    "GitHub token is available in the environment variable GITHUB_TOKEN.\n" +
    "The repository has already been cloned to your working directory."
  );
}

export function buildPrUserMessage(target: Extract<RunTarget, { kind: "pr" }>): string {
  const reviewSection = target.reviewBody ? `\n${target.reviewBody}\n` : "";
  return (
    `Repository: ${target.repo}\n` +
    `PR #${target.number}: ${target.title}\n\n` +
    `${target.body}\n\n` +
    `Head branch: ${target.headBranch}\n` +
    `Base branch: ${target.baseBranch}\n` +
    "Diff: see diff.patch in your working directory.\n" +
    `${reviewSection}\n` +
    "GitHub token is available in the environment variable GITHUB_TOKEN.\n" +
    "The repository has already been cloned to your working directory."
  );
}
