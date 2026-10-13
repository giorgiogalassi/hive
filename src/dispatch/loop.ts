import type { ReviewState } from "../vcs/port.js";

export type LoopDecision = "requeue" | "approved" | "human_review" | "ignore";

export const MAX_CODY_RUNS = 3;

interface PrLoopState {
  codyRuns: number;
  firstReviewPosted: boolean;
}

/** In-memory rework-loop state keyed by (repo, prNumber). Pure decisions; the caller applies labels. */
export class ReworkLoop {
  private readonly state = new Map<string, PrLoopState>();

  get(repo: string, prNumber: number): PrLoopState {
    const key = `${repo}#${prNumber}`;
    let s = this.state.get(key);
    if (!s) {
      s = { codyRuns: 0, firstReviewPosted: false };
      this.state.set(key, s);
    }
    return s;
  }

  onReview(repo: string, prNumber: number, state: ReviewState): LoopDecision {
    const s = this.get(repo, prNumber);
    if (state === "approved") {
      s.firstReviewPosted = true;
      return "approved";
    }
    if (state === "changes_requested") {
      if (s.codyRuns < MAX_CODY_RUNS) {
        s.codyRuns += 1;
        s.firstReviewPosted = true;
        return "requeue";
      }
      return "human_review";
    }
    return "ignore";
  }

  /** Owner comments always requeue once a first review exists, regardless of the run count. */
  onOwnerComment(repo: string, prNumber: number): LoopDecision {
    const s = this.get(repo, prNumber);
    if (!s.firstReviewPosted) return "ignore";
    s.codyRuns += 1;
    return "requeue";
  }
}
