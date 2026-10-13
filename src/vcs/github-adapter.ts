/**
 * GitHub implementation of VcsPort. This is the only module that may reference
 * GitHub payload field names or API URLs.
 *
 * Requires GITHUB_TOKEN (read at call time).
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  VcsHttpError,
  VcsTimeoutError,
  type Issue,
  type NormalizedEvent,
  type PullRequestSummary,
  type ReviewState,
  type SubmittedReview,
  type VcsPort,
} from "./port.js";

const execFileAsync = promisify(execFile);

const GITHUB_API = "https://api.github.com";

/** Per-request timeout; matches the 30 s `_HTTP_TIMEOUT` of the Python adapter. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export interface GitHubAdapterOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to reading GITHUB_TOKEN at call time. */
  token?: () => string | undefined;
}

// Untyped provider JSON boundary; the only place loose typing is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export function parseNextLink(linkHeader: string): string | null {
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

export function parseDependsOn(body: string): number[] {
  const deps: number[] = [];
  const seen = new Set<number>();
  for (const match of body.matchAll(/depends-on:\s*((?:#\d+(?:\s*,\s*)?)+)/gi)) {
    for (const num of (match[1] ?? "").matchAll(/#(\d+)/g)) {
      const n = Number(num[1]);
      if (!seen.has(n)) {
        seen.add(n);
        deps.push(n);
      }
    }
  }
  return deps;
}

function toIssue(raw: Json): Issue {
  return { number: raw.number, title: raw.title, body: raw.body || "" };
}

export class GitHubAdapter implements VcsPort {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenFn: () => string | undefined;

  constructor(options: GitHubAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.tokenFn = options.token ?? (() => process.env["GITHUB_TOKEN"]);
  }

  // -- webhook parsing -----------------------------------------------------

  parseEvent(
    headers: Record<string, string | undefined>,
    rawBody: string | Uint8Array,
  ): NormalizedEvent | null {
    let eventType = "";
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "x-github-event") eventType = v ?? "";
    }

    let payload: Json;
    try {
      const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      payload = parsed as Json;
    } catch {
      return null;
    }

    const action: string = payload["action"] ?? "";
    const repo: string = payload["repository"]?.full_name ?? "";

    if (eventType === "issues" && action === "labeled") {
      return {
        type: "issue_labeled",
        repo,
        issueNumber: payload["issue"].number,
        label: payload["label"].name,
      };
    }

    if (eventType === "pull_request") {
      const pr: Json = payload["pull_request"] ?? {};
      if (action === "opened") {
        return {
          type: "pr_opened",
          repo,
          prNumber: pr["number"],
          title: pr["title"],
          headBranch: pr["head"].ref,
          baseBranch: pr["base"].ref,
          author: pr["user"].login,
        };
      }
      if (action === "labeled") {
        return {
          type: "pr_labeled",
          repo,
          prNumber: pr["number"],
          label: payload["label"].name,
        };
      }
    }

    if (eventType === "pull_request_review" && action === "submitted") {
      const review: Json = payload["review"] ?? {};
      const raw = String(review["state"] ?? "commented").toLowerCase();
      const state: ReviewState =
        raw === "approved" || raw === "changes_requested" ? raw : "commented";
      return {
        type: "pr_review_submitted",
        repo,
        prNumber: payload["pull_request"].number,
        state,
        body: review["body"] || "",
        author: review["user"].login,
      };
    }

    if (eventType === "issue_comment" && action === "created") {
      const issue: Json = payload["issue"] ?? {};
      const comment: Json = payload["comment"] ?? {};
      return {
        type: "issue_comment",
        repo,
        number: issue["number"],
        body: comment["body"] ?? "",
        author: comment["user"].login,
        isPr: "pull_request" in issue,
      };
    }

    return null;
  }

  // -- labels --------------------------------------------------------------

  async applyLabel(repo: string, number: number, label: string): Promise<void> {
    await this.request("POST", `${GITHUB_API}/repos/${repo}/issues/${number}/labels`, {
      labels: [label],
    });
  }

  async hasLabel(repo: string, number: number, label: string): Promise<boolean> {
    const res = await this.request("GET", `${GITHUB_API}/repos/${repo}/issues/${number}/labels`);
    const labels = (await res.json()) as Json[];
    return labels.some((l) => l["name"] === label);
  }

  // -- pull requests -------------------------------------------------------

  async postReview(
    repo: string,
    prNumber: number,
    body: string,
    state: string,
  ): Promise<void> {
    const event =
      state === "approved" ? "APPROVE" : state === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
    await this.request("POST", `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews`, {
      body,
      event,
    });
  }

  async postComment(repo: string, number: number, body: string): Promise<void> {
    await this.request("POST", `${GITHUB_API}/repos/${repo}/issues/${number}/comments`, { body });
  }

  async getPrDiff(repo: string, prNumber: number, workdir: string): Promise<string> {
    const res = await this.request("GET", `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`);
    const pr = (await res.json()) as Json;
    const head: string = pr["head"].ref;
    const base: string = pr["base"].ref;

    await runGit(["fetch", "origin"], workdir);
    await runGit(["checkout", head], workdir);
    // Three-dot diff: changes on head that are not on base.
    const diff = await runGit(["diff", `origin/${base}...${head}`], workdir);

    const patchPath = join(workdir, "diff.patch");
    await writeFile(patchPath, diff);
    return patchPath;
  }

  async listOpenPullRequests(repo: string): Promise<PullRequestSummary[]> {
    const items = await this.paginate(
      `${GITHUB_API}/repos/${repo}/pulls?state=open&per_page=100`,
    );
    return items.map((pr) => ({
      number: pr["number"],
      title: pr["title"],
      headBranch: pr["head"].ref,
      baseBranch: pr["base"].ref,
      author: pr["user"]?.login ?? "",
    }));
  }

  async getLatestReview(repo: string, prNumber: number): Promise<SubmittedReview | null> {
    const items = await this.paginate(
      `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    );
    // The API lists reviews oldest first.
    for (const r of items.reverse()) {
      const state: ReviewState | null =
        r["state"] === "APPROVED"
          ? "approved"
          : r["state"] === "CHANGES_REQUESTED"
            ? "changes_requested"
            : r["state"] === "COMMENTED"
              ? "commented"
              : null;
      if (state === null) continue;
      return { id: r["id"], state, body: r["body"] ?? "", author: r["user"]?.login ?? "" };
    }
    return null;
  }

  // -- issues --------------------------------------------------------------

  async listIssues(repo: string, label: string): Promise<Issue[]> {
    const items = await this.paginate(
      `${GITHUB_API}/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`,
    );
    return items.map(toIssue);
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const res = await this.request("GET", `${GITHUB_API}/repos/${repo}/issues/${number}`);
    return toIssue((await res.json()) as Json);
  }

  async getIssueDependencies(repo: string, number: number): Promise<number[]> {
    // Strategy 1: sub-issues API (not available everywhere).
    try {
      const res = await this.rawRequest(
        "GET",
        `${GITHUB_API}/repos/${repo}/issues/${number}/sub_issues`,
      );
      if (res.ok) {
        const subs = (await res.json()) as Json[];
        if (subs.length > 0) return [...new Set(subs.map((s) => s["number"] as number))];
      }
    } catch (err) {
      if (!(err instanceof VcsTimeoutError) && !(err instanceof TypeError)) throw err;
    }

    // Strategy 2: "Depends-on: #N" in the issue body.
    try {
      const issue = await this.getIssue(repo, number);
      return parseDependsOn(issue.body);
    } catch (err) {
      if (!(err instanceof VcsHttpError) && !(err instanceof VcsTimeoutError) && !(err instanceof TypeError)) {
        throw err;
      }
      return [];
    }
  }

  // -- http ----------------------------------------------------------------

  private async paginate(firstUrl: string): Promise<Json[]> {
    const out: Json[] = [];
    let url: string | null = firstUrl;
    while (url) {
      const res = await this.request("GET", url);
      out.push(...((await res.json()) as Json[]));
      url = parseNextLink(res.headers.get("Link") ?? "");
    }
    return out;
  }

  /** Like rawRequest but throws VcsHttpError on non-2xx. */
  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    const res = await this.rawRequest(method, url, body);
    if (!res.ok) {
      throw new VcsHttpError(res.status, `${method} ${url} failed with HTTP ${res.status}`);
    }
    return res;
  }

  private async rawRequest(method: string, url: string, body?: unknown): Promise<Response> {
    const token = this.tokenFn();
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN environment variable is not set. GitHubAdapter requires it for all API calls.",
      );
    }
    const headers: Record<string, string> = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await this.fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new VcsTimeoutError(url, this.timeoutMs);
      }
      throw err;
    }
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new Error(`git command failed: git ${args.join(" ")}\nstderr: ${stderr}`);
  }
}
