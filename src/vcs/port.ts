/**
 * Provider-agnostic VCS port. No provider-specific field names, URLs or HTTP
 * client references may appear in this module; adapters live in sibling files.
 */

export interface PROpened {
  type: "pr_opened";
  repo: string;
  prNumber: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  author: string;
}

export interface PRLabeled {
  type: "pr_labeled";
  repo: string;
  prNumber: number;
  label: string;
}

export type ReviewState = "approved" | "changes_requested" | "commented";

export interface PRReviewSubmitted {
  type: "pr_review_submitted";
  repo: string;
  prNumber: number;
  state: ReviewState;
  body: string;
  author: string;
}

export interface IssueComment {
  type: "issue_comment";
  repo: string;
  number: number;
  body: string;
  author: string;
  isPr: boolean;
}

export interface IssueLabeled {
  type: "issue_labeled";
  repo: string;
  issueNumber: number;
  label: string;
}

export type NormalizedEvent =
  | PROpened
  | PRLabeled
  | PRReviewSubmitted
  | IssueComment
  | IssueLabeled;

export interface Issue {
  number: number;
  title: string;
  body: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  author: string;
}

export interface PullRequestDetails extends PullRequestSummary {
  body: string;
}

/** Hidden marker appended to every comment Hive posts, so its own comments are never treated as human input. */
export const BOT_MARKER = "<!-- hive:bot -->";

export interface SubmittedReview {
  id: number;
  state: ReviewState;
  body: string;
  author: string;
}

/** Thrown when the provider answers with a non-2xx status. */
export class VcsHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VcsHttpError";
    this.status = status;
  }
}

/** Thrown when an outbound request exceeds the per-request timeout. */
export class VcsTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "VcsTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface VcsPort {
  /** Returns null for unhandled event types, ping and undecodable bodies. */
  parseEvent(
    headers: Record<string, string | undefined>,
    rawBody: string | Uint8Array,
  ): NormalizedEvent | null;
  /** Idempotent. */
  applyLabel(repo: string, number: number, label: string): Promise<void>;
  hasLabel(repo: string, number: number, label: string): Promise<boolean>;
  /** Unknown states are submitted as a plain comment review. */
  postReview(
    repo: string,
    prNumber: number,
    body: string,
    state: ReviewState | string,
  ): Promise<void>;
  postComment(repo: string, number: number, body: string): Promise<void>;
  /** Writes `diff.patch` into `workdir` (an existing clone) and returns its path. */
  getPrDiff(repo: string, prNumber: number, workdir: string): Promise<string>;
  /** Open issues carrying `label`, following pagination. */
  listIssues(repo: string, label: string): Promise<Issue[]>;
  getIssue(repo: string, number: number): Promise<Issue>;
  /** Sub-issues first, then `Depends-on: #N` body parsing; deduplicated. */
  getIssueDependencies(repo: string, number: number): Promise<number[]>;
  listOpenPullRequests(repo: string): Promise<PullRequestSummary[]>;
  getPullRequest(repo: string, prNumber: number): Promise<PullRequestDetails>;
  /** Most recent submitted (non-pending, non-dismissed) review on a PR, or null when none. */
  getLatestReview(repo: string, prNumber: number): Promise<SubmittedReview | null>;
}
