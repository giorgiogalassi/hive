"""
loop.py — Rework-loop state and decision logic for the Hive orchestration system.

This module owns all decisions about whether to re-queue Cody, approve a PR, or
escalate to a human reviewer.  main.py (and any other entry point) calls into
these functions after normalizing raw webhook events; it never makes loop
decisions itself.

State is stored in a module-level dict keyed by (repo, pr_number) so that every
handler within a single process shares the same view without requiring a database.
"""

from __future__ import annotations

import os

from hive.runner.vcs.port import VCSPort, PRReviewSubmittedEvent, IssueCommentEvent

# ---------------------------------------------------------------------------
# In-process loop state
# ---------------------------------------------------------------------------

# Keyed by (repo, pr_number).
# Each value is a dict with:
#   cody_runs           int   – number of times Cody has been re-queued
#   first_review_posted bool  – True once the first Cody review has appeared
_state: dict[tuple[str, int], dict] = {}

# Maximum number of automated Cody re-queues before escalating to a human.
_MAX_CODY_RUNS = 3


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def get_state(repo: str, pr_number: int) -> dict:
    """Return the loop state for *repo*/*pr_number*, initializing it if absent.

    The returned dict is the live entry stored in ``_state``; callers that
    mutate it are updating the shared state directly.

    Args:
        repo: Full repository identifier in ``owner/repo`` form.
        pr_number: Pull request number.

    Returns:
        A dict with keys ``cody_runs`` (int) and ``first_review_posted`` (bool).
    """
    key = (repo, pr_number)
    if key not in _state:
        _state[key] = {"cody_runs": 0, "first_review_posted": False}
    return _state[key]


def on_review_submitted(vcs: VCSPort, event: PRReviewSubmittedEvent) -> str:
    """Decide what to do when a PR review is submitted.

    Decision table:

    * ``"approved"``   → mark first review posted, return ``"approved"``.
    * ``"changes_requested"`` and ``cody_runs < 3`` → increment counter,
      mark first review posted, return ``"requeue"``.
    * ``"changes_requested"`` and ``cody_runs >= 3`` → apply the
      ``"human:review"`` label and return ``"human_review"``.
    * Any other state (e.g. ``"commented"``) → return ``"ignore"``.

    Args:
        vcs: A :class:`~hive.runner.vcs.port.VCSPort` implementation used for
            label operations.
        event: The normalized review-submitted event from the VCS adapter.

    Returns:
        One of ``"requeue"``, ``"approved"``, ``"human_review"``, or
        ``"ignore"``.
    """
    state = get_state(event.repo, event.pr_number)

    if event.state == "approved":
        state["first_review_posted"] = True
        return "approved"

    if event.state == "changes_requested":
        if state["cody_runs"] < _MAX_CODY_RUNS:
            state["cody_runs"] += 1
            state["first_review_posted"] = True
            return "requeue"
        else:
            # Cody has already been re-queued the maximum number of times;
            # escalate to a human reviewer by applying the label.
            vcs.apply_label(event.repo, event.pr_number, "human:review")
            return "human_review"

    # "commented" and any future review states are silently ignored.
    return "ignore"


def on_owner_comment(event: IssueCommentEvent) -> str:
    """Decide what to do when the repo owner comments on a PR.

    Owner comments are only meaningful after Cody has posted at least one
    review (``first_review_posted == True``).  If no Cody review exists yet
    the comment is ignored so that the initial conversation before the first
    automated review does not accidentally trigger a re-queue.

    Unlike the automated review path, owner comments always re-queue Cody
    regardless of how many runs have already occurred — a human explicitly
    asked for more work.

    Args:
        event: The normalized issue-comment event.  The ``number`` field is
            used as the PR number for state look-up.

    Returns:
        ``"requeue"`` if a Cody review has already been posted, otherwise
        ``"ignore"``.
    """
    state = get_state(event.repo, event.number)

    if not state["first_review_posted"]:
        return "ignore"

    # Human comments always re-queue regardless of the run count.
    state["cody_runs"] += 1
    return "requeue"


def is_repo_owner(author: str) -> bool:
    """Return ``True`` if *author* matches the configured repo owner.

    The expected owner is read from the ``GITHUB_OWNER`` environment variable.
    An empty or unset variable means no author will ever match, which is a
    safe default (no unexpected re-queues).

    Args:
        author: GitHub username to check.

    Returns:
        ``True`` if *author* equals ``GITHUB_OWNER``, ``False`` otherwise.
    """
    return author == os.environ.get("GITHUB_OWNER", "")
