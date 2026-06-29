"""
port.py — Abstract VCS port for the Hive orchestration system.

Defines normalized event dataclasses and the abstract VCSPort interface.
All types in this module are VCS-provider-agnostic: no provider-specific
imports, field names, or HTTP client references appear here.  Concrete
adapters (e.g. GitHub, GitLab) live in sibling modules and inherit from
VCSPort.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, Union


# ---------------------------------------------------------------------------
# Normalized event dataclasses
# ---------------------------------------------------------------------------

@dataclass
class PROpenedEvent:
    """Fired when a pull request is opened against any branch.

    Attributes:
        repo: Full repository identifier in ``owner/repo`` form.
        pr_number: Provider-assigned pull request number.
        title: Pull request title as set by the author.
        head_branch: The branch that contains the proposed changes.
        base_branch: The target branch the PR would merge into.
        author: Username of the PR author.
    """

    repo: str
    pr_number: int
    title: str
    head_branch: str
    base_branch: str
    author: str


@dataclass
class PRLabeledEvent:
    """Fired when a label is applied to a pull request.

    Attributes:
        repo: Full repository identifier in ``owner/repo`` form.
        pr_number: Provider-assigned pull request number.
        label: Name of the label that was applied.
    """

    repo: str
    pr_number: int
    label: str


@dataclass
class PRReviewSubmittedEvent:
    """Fired when a reviewer submits a review on a pull request.

    Attributes:
        repo: Full repository identifier in ``owner/repo`` form.
        pr_number: Provider-assigned pull request number.
        state: Review outcome — one of ``"approved"``, ``"changes_requested"``,
            or ``"commented"``.
        body: Review comment body, possibly empty.
        author: Username of the reviewer.
    """

    repo: str
    pr_number: int
    state: Literal["approved", "changes_requested", "commented"]
    body: str
    author: str


@dataclass
class IssueCommentEvent:
    """Fired when a comment is posted on an issue or pull request.

    Attributes:
        repo: Full repository identifier in ``owner/repo`` form.
        number: Issue or pull request number.
        body: Text of the comment.
        author: Username of the commenter.
        is_pr: ``True`` when the comment belongs to a pull request,
            ``False`` for a plain issue.
    """

    repo: str
    number: int
    body: str
    author: str
    is_pr: bool


@dataclass
class IssueLabeledEvent:
    """Fired when a label is applied to an issue.

    Attributes:
        repo: Full repository identifier in ``owner/repo`` form.
        issue_number: Provider-assigned issue number.
        label: Name of the label that was applied.
    """

    repo: str
    issue_number: int
    label: str


# Union of all normalized event types returned by VCSPort.parse_event.
NormalizedEvent = Union[
    PROpenedEvent,
    PRLabeledEvent,
    PRReviewSubmittedEvent,
    IssueCommentEvent,
    IssueLabeledEvent,
]


# ---------------------------------------------------------------------------
# Abstract VCS port
# ---------------------------------------------------------------------------

class VCSPort(ABC):
    """Provider-agnostic interface for all VCS operations used by Hive.

    Concrete subclasses implement each method against a specific VCS
    provider (GitHub, GitLab, Bitbucket, …).  The rest of the system
    interacts exclusively through this interface so that provider details
    never leak into agent runners or event dispatchers.
    """

    @abstractmethod
    def parse_event(self, headers: dict, raw_body: bytes) -> NormalizedEvent | None:
        """Parse a raw inbound webhook into a normalized event object.

        Args:
            headers: HTTP request headers as a plain dict, lower-cased keys
                recommended but not required.
            raw_body: The unmodified request body bytes, as received from the
                network before any deserialization.

        Returns:
            A :data:`NormalizedEvent` instance representing the event, or
            ``None`` when the payload describes an event type that Hive does
            not handle.
        """

    @abstractmethod
    def apply_label(self, repo: str, number: int, label: str) -> None:
        """Apply *label* to issue or pull request *number* in *repo*.

        This operation is idempotent: applying a label that is already
        present must not raise an error.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            label: Name of the label to apply.
        """

    @abstractmethod
    def has_label(self, repo: str, number: int, label: str) -> bool:
        """Return ``True`` if *label* is currently applied to *number*.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            label: Name of the label to check.

        Returns:
            ``True`` if the label is present, ``False`` otherwise.
        """

    @abstractmethod
    def post_review(
        self,
        repo: str,
        pr_number: int,
        body: str,
        state: str,
    ) -> None:
        """Submit a review comment on a pull request.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            pr_number: Pull request number.
            body: Markdown body of the review.
            state: Review state string — typically ``"APPROVE"``,
                ``"REQUEST_CHANGES"``, or ``"COMMENT"``.
        """

    @abstractmethod
    def post_comment(self, repo: str, number: int, body: str) -> None:
        """Post a plain comment on an issue or pull request.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            body: Markdown body of the comment.
        """

    @abstractmethod
    def get_pr_diff(self, repo: str, pr_number: int, workdir: str) -> str:
        """Return the unified diff for a pull request.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            pr_number: Pull request number.
            workdir: Path to a local directory where temporary git operations
                may be performed if the provider requires them.

        Returns:
            A unified-diff string representing all changes in the PR.
        """

    @abstractmethod
    def list_issues(self, repo: str, label: str) -> list[dict]:
        """Return all open issues that carry *label*.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            label: Label name to filter by.

        Returns:
            A list of provider-agnostic issue dicts.  Each dict must at
            minimum contain the keys ``number``, ``title``, and ``body``.
        """

    @abstractmethod
    def get_issue(self, repo: str, number: int) -> dict:
        """Return metadata for a single issue.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue number.

        Returns:
            A provider-agnostic dict containing at minimum ``number``,
            ``title``, and ``body``.
        """

    @abstractmethod
    def get_issue_dependencies(self, repo: str, number: int) -> list[int]:
        """Return the issue numbers that *number* depends on.

        Implementations should parse dependency references from the issue
        body (e.g. ``Blocked by: #12``) and return them as a list of ints.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue number whose dependencies are requested.

        Returns:
            A (possibly empty) list of issue numbers that must be resolved
            before *number* can proceed.
        """
