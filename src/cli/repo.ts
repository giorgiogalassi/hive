import { execFileSync } from "node:child_process";

/** Parses `owner/repo` from an HTTPS or SSH GitHub remote URL; "" when unrecognised. */
export function parseRemoteUrl(url: string): string {
  const m = /^(?:https?:\/\/[^/]+\/|[^@\s]+@[^:\s]+:|ssh:\/\/[^/]+\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1] ?? "";
}

export function detectOriginRepo(cwd: string = process.cwd()): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseRemoteUrl(url);
  } catch {
    return "";
  }
}

export const REPO_GUIDANCE =
  "ERROR: could not determine repository. Use --repo, set GITHUB_REPO, or run from inside a git repo with an 'origin' remote.";

/** Order: --repo, then GITHUB_REPO, then the origin remote. */
export function resolveRepo(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  detect: () => string = detectOriginRepo,
): string {
  return flag || env["GITHUB_REPO"] || detect();
}
