import type { NormalizedEvent, ReviewState } from "../vcs/port.js";

/** The events the dispatcher understands; shared by the webhook and `hive run`. */
export type HiveEvent =
  | { type: "issue_labeled"; repo: string; issueNumber: number; label: string }
  | {
      type: "pr_opened";
      repo: string;
      prNumber: number;
      title: string;
      headBranch: string;
      baseBranch: string;
      author: string;
    }
  | { type: "pr_labeled"; repo: string; prNumber: number; label: string }
  | { type: "review_submitted"; repo: string; prNumber: number; state: ReviewState; body: string; author: string }
  | { type: "pr_comment"; repo: string; prNumber: number; body: string; author: string };

/** Maps a VcsPort event to a HiveEvent; null for events with no dispatch meaning (plain issue comments). */
export function toHiveEvent(event: NormalizedEvent): HiveEvent | null {
  switch (event.type) {
    case "issue_labeled":
      return { type: "issue_labeled", repo: event.repo, issueNumber: event.issueNumber, label: event.label };
    case "pr_opened":
      return {
        type: "pr_opened",
        repo: event.repo,
        prNumber: event.prNumber,
        title: event.title,
        headBranch: event.headBranch,
        baseBranch: event.baseBranch,
        author: event.author,
      };
    case "pr_labeled":
      return { type: "pr_labeled", repo: event.repo, prNumber: event.prNumber, label: event.label };
    case "pr_review_submitted":
      return {
        type: "review_submitted",
        repo: event.repo,
        prNumber: event.prNumber,
        state: event.state,
        body: event.body,
        author: event.author,
      };
    case "issue_comment":
      if (!event.isPr) return null;
      return { type: "pr_comment", repo: event.repo, prNumber: event.number, body: event.body, author: event.author };
  }
}
