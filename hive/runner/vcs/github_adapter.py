"""
github_adapter.py — GitHub implementation of VCSPort for the Hive system.

This is the single module in the codebase that may reference GitHub-specific
API field names, webhook payload shapes, or endpoint URLs. The rest of the
system interacts exclusively through the provider-agnostic VCSPort interface.

Environment variable required:
    GITHUB_TOKEN: A GitHub personal access token or installation token with
        repo read/write access (issues, pull requests, contents).
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from typing import Optional

import requests

from hive.runner.vcs.port import (
    IssueCommentEvent,
    IssueLabeledEvent,
    NormalizedEvent,
    PRLabeledEvent,
    PROpenedEvent,
    PRReviewSubmittedEvent,
    VCSPort,
)

logger = logging.getLogger(__name__)

# Base URL for all GitHub REST API v3 calls.
_GITHUB_API = "https://api.github.com"


def _auth_headers() -> dict[str, str]:
    """Return HTTP headers required for authenticated GitHub API requests.

    Reads ``GITHUB_TOKEN`` from the environment at call time so that the token
    can be rotated or injected via container secrets without restarting the
    process.

    Returns:
        A dict containing ``Authorization`` and ``Accept`` headers.

    Raises:
        RuntimeError: If ``GITHUB_TOKEN`` is not set in the environment.
    """
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError(
            "GITHUB_TOKEN environment variable is not set. "
            "GitHubAdapter requires it for all API calls."
        )
    return {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }


class GitHubAdapter(VCSPort):
    """Concrete VCSPort implementation that targets the GitHub REST API.

    All GitHub-specific knowledge — webhook payload shapes, JSON field names,
    and API endpoint paths — is encapsulated in this class. No other module in
    the Hive system may reference GitHub-specific details.
    """

    # ------------------------------------------------------------------
    # Webhook event parsing
    # ------------------------------------------------------------------

    def parse_event(self, headers: dict, raw_body: bytes) -> Optional[NormalizedEvent]:
        """Parse a GitHub webhook payload into a normalized event object.

        Dispatches on the ``X-GitHub-Event`` header (case-insensitive lookup)
        and the ``action`` field in the JSON body. Returns ``None`` for any
        event/action combination that Hive does not handle so callers can
        safely ignore it.

        Args:
            headers: HTTP request headers. The lookup for ``X-GitHub-Event``
                is case-insensitive.
            raw_body: Raw request body bytes, decoded as UTF-8 JSON here.

        Returns:
            A :data:`NormalizedEvent` instance for supported events, or
            ``None`` for unrecognized events.
        """
        # Normalize header lookup to be case-insensitive.
        lower_headers = {k.lower(): v for k, v in headers.items()}
        event_type = lower_headers.get("x-github-event", "")

        try:
            payload: dict = json.loads(raw_body)
        except json.JSONDecodeError:
            logger.warning("parse_event: failed to decode JSON body")
            return None

        action: str = payload.get("action", "")
        repo: str = payload.get("repository", {}).get("full_name", "")

        if event_type == "issues" and action == "labeled":
            return IssueLabeledEvent(
                repo=repo,
                issue_number=payload["issue"]["number"],
                label=payload["label"]["name"],
            )

        if event_type == "pull_request":
            pr = payload.get("pull_request", {})
            if action == "opened":
                return PROpenedEvent(
                    repo=repo,
                    pr_number=pr["number"],
                    title=pr["title"],
                    head_branch=pr["head"]["ref"],
                    base_branch=pr["base"]["ref"],
                    author=pr["user"]["login"],
                )
            if action == "labeled":
                return PRLabeledEvent(
                    repo=repo,
                    pr_number=pr["number"],
                    label=payload["label"]["name"],
                )

        if event_type == "pull_request_review" and action == "submitted":
            review = payload.get("review", {})
            raw_state = review.get("state", "commented").lower()
            # GitHub sends APPROVED / CHANGES_REQUESTED / COMMENTED (upper-case).
            # Normalize to the lower-case literals expected by PRReviewSubmittedEvent.
            state_map = {
                "approved": "approved",
                "changes_requested": "changes_requested",
                "commented": "commented",
            }
            state = state_map.get(raw_state, "commented")
            return PRReviewSubmittedEvent(
                repo=repo,
                pr_number=payload["pull_request"]["number"],
                state=state,  # type: ignore[arg-type]
                body=review.get("body") or "",
                author=review["user"]["login"],
            )

        if event_type == "issue_comment" and action == "created":
            issue = payload.get("issue", {})
            comment = payload.get("comment", {})
            # GitHub attaches a "pull_request" key to issue objects when the
            # issue is actually a pull request thread.
            is_pr = "pull_request" in issue
            return IssueCommentEvent(
                repo=repo,
                number=issue["number"],
                body=comment.get("body", ""),
                author=comment["user"]["login"],
                is_pr=is_pr,
            )

        logger.debug(
            "parse_event: unrecognized event=%s action=%s — returning None",
            event_type,
            action,
        )
        return None

    # ------------------------------------------------------------------
    # Label operations
    # ------------------------------------------------------------------

    def apply_label(self, repo: str, number: int, label: str) -> None:
        """Apply *label* to issue or pull request *number* in *repo*.

        Idempotent: GitHub silently ignores labels that are already present.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            label: Name of the label to apply.

        Raises:
            requests.HTTPError: If the API returns a non-2xx status.
        """
        url = f"{_GITHUB_API}/repos/{repo}/issues/{number}/labels"
        response = requests.post(url, headers=_auth_headers(), json={"labels": [label]})
        response.raise_for_status()
        logger.debug("apply_label: repo=%s number=%d label=%s", repo, number, label)

    def has_label(self, repo: str, number: int, label: str) -> bool:
        """Return ``True`` if *label* is currently applied to *number*.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            label: Name of the label to check for.

        Returns:
            ``True`` when the label is present, ``False`` otherwise.

        Raises:
            requests.HTTPError: If the API returns a non-2xx status.
        """
        url = f"{_GITHUB_API}/repos/{repo}/issues/{number}/labels"
        response = requests.get(url, headers=_auth_headers())
        response.raise_for_status()
        labels: list[dict] = response.json()
        return any(lbl["name"] == label for lbl in labels)

    # ------------------------------------------------------------------
    # Pull request operations
    # ------------------------------------------------------------------

    def post_review(
        self,
        repo: str,
        pr_number: int,
        body: str,
        state: str,
    ) -> None:
        """Submit a review on a pull request.

        Maps the normalized state strings used internally by Hive to the
        upper-case literals required by the GitHub Reviews API.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            pr_number: Pull request number.
            body: Markdown body of the review.
            state: One of ``"approved"`` or ``"changes_requested"``. Any
                other value is submitted as ``"COMMENT"``.

        Raises:
            requests.HTTPError: If the API returns a non-2xx status.
        """
        state_map = {
            "approved": "APPROVED",
            "changes_requested": "REQUEST_CHANGES",
        }
        github_state = state_map.get(state, "COMMENT")
        url = f"{_GITHUB_API}/repos/{repo}/pulls/{pr_number}/reviews"
        response = requests.post(
            url,
            headers=_auth_headers(),
            json={"body": body, "event": github_state},
        )
        response.raise_for_status()
        logger.debug(
            "post_review: repo=%s pr=%d state=%s", repo, pr_number, github_state
        )

    def post_comment(self, repo: str, number: int, body: str) -> None:
        """Post a plain comment on an issue or pull request.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue or pull request number.
            body: Markdown body of the comment.

        Raises:
            requests.HTTPError: If the API returns a non-2xx status.
        """
        url = f"{_GITHUB_API}/repos/{repo}/issues/{number}/comments"
        response = requests.post(url, headers=_auth_headers(), json={"body": body})
        response.raise_for_status()
        logger.debug("post_comment: repo=%s number=%d", repo, number)

    def get_pr_diff(self, repo: str, pr_number: int, workdir: str) -> str:
        """Return the path to a unified diff file for a pull request.

        Fetches the PR's head and base branches from the GitHub API, then runs
        git inside *workdir* (which must already contain a clone of the repo)
        to produce the diff. Writes the output to ``diff.patch`` inside
        *workdir* and returns that path.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            pr_number: Pull request number.
            workdir: Path to an existing local clone of *repo*.

        Returns:
            Absolute path to ``{workdir}/diff.patch``.

        Raises:
            requests.HTTPError: If the PR metadata API call fails.
            RuntimeError: If any git command exits with a non-zero status.
        """
        # Retrieve head and base branch names from the GitHub API.
        url = f"{_GITHUB_API}/repos/{repo}/pulls/{pr_number}"
        response = requests.get(url, headers=_auth_headers())
        response.raise_for_status()
        pr_data = response.json()
        head_branch: str = pr_data["head"]["ref"]
        base_branch: str = pr_data["base"]["ref"]

        # Fetch all remote refs so both branches are available locally.
        _run_git(["git", "fetch", "origin"], cwd=workdir)
        _run_git(["git", "checkout", head_branch], cwd=workdir)

        # Three-dot diff: changes on head_branch that are not on base_branch.
        diff_output = _run_git(
            ["git", "diff", f"origin/{base_branch}...{head_branch}"],
            cwd=workdir,
        )

        patch_path = os.path.join(workdir, "diff.patch")
        with open(patch_path, "w") as f:
            f.write(diff_output)

        logger.debug(
            "get_pr_diff: repo=%s pr=%d head=%s base=%s patch=%s",
            repo,
            pr_number,
            head_branch,
            base_branch,
            patch_path,
        )
        return patch_path

    # ------------------------------------------------------------------
    # Issue operations
    # ------------------------------------------------------------------

    def list_issues(self, repo: str, label: str) -> list[dict]:
        """Return all open issues carrying *label*, following pagination.

        Normalizes each GitHub issue dict to ensure ``number``, ``title``,
        and ``body`` are always present, stripping GitHub-specific fields
        that callers should not rely on.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            label: Label name to filter by.

        Returns:
            A list of issue dicts, each containing at minimum ``number``,
            ``title``, and ``body``.

        Raises:
            requests.HTTPError: If any paginated API call fails.
        """
        url: Optional[str] = (
            f"{_GITHUB_API}/repos/{repo}/issues"
            f"?labels={label}&state=open&per_page=100"
        )
        issues: list[dict] = []

        while url:
            response = requests.get(url, headers=_auth_headers())
            response.raise_for_status()
            page: list[dict] = response.json()
            issues.extend(
                {
                    "number": item["number"],
                    "title": item["title"],
                    "body": item.get("body") or "",
                }
                for item in page
            )
            # Follow GitHub's Link header for the next page, if present.
            url = _parse_next_link(response.headers.get("Link", ""))

        logger.debug(
            "list_issues: repo=%s label=%s total=%d", repo, label, len(issues)
        )
        return issues

    def get_issue(self, repo: str, number: int) -> dict:
        """Return metadata for a single issue.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue number.

        Returns:
            A dict containing at minimum ``number``, ``title``, and ``body``.

        Raises:
            requests.HTTPError: If the API returns a non-2xx status.
        """
        url = f"{_GITHUB_API}/repos/{repo}/issues/{number}"
        response = requests.get(url, headers=_auth_headers())
        response.raise_for_status()
        raw: dict = response.json()
        return {
            "number": raw["number"],
            "title": raw["title"],
            "body": raw.get("body") or "",
        }

    def get_issue_dependencies(self, repo: str, number: int) -> list[int]:
        """Return issue numbers that *number* depends on.

        Resolution strategy (in order):
        1. Call the GitHub sub-issues API. If it returns a non-empty list,
           extract and return the sub-issue numbers.
        2. If the sub-issues endpoint returns 404/410 or an empty list, fall
           back to parsing the issue body for lines matching the patterns
           ``Depends-on: #N`` or ``Depends-on: #N, #M, …``.
        3. If neither strategy yields results, return an empty list.

        Args:
            repo: Full repository identifier in ``owner/repo`` form.
            number: Issue number whose dependencies are requested.

        Returns:
            A (possibly empty) list of dependency issue numbers.
        """
        # Strategy 1: GitHub sub-issues API (may not be available on all plans).
        sub_url = f"{_GITHUB_API}/repos/{repo}/issues/{number}/sub_issues"
        try:
            sub_response = requests.get(sub_url, headers=_auth_headers())
            if sub_response.status_code in (404, 410):
                logger.debug(
                    "get_issue_dependencies: sub_issues endpoint returned %d for %s#%d",
                    sub_response.status_code,
                    repo,
                    number,
                )
            elif sub_response.ok:
                sub_issues: list[dict] = sub_response.json()
                if sub_issues:
                    dep_numbers = [item["number"] for item in sub_issues]
                    logger.debug(
                        "get_issue_dependencies: sub_issues=%s for %s#%d",
                        dep_numbers,
                        repo,
                        number,
                    )
                    return dep_numbers
        except requests.RequestException as exc:
            logger.warning(
                "get_issue_dependencies: sub_issues request failed for %s#%d: %s",
                repo,
                number,
                exc,
            )

        # Strategy 2: Parse the issue body for "Depends-on: #N" patterns.
        try:
            issue = self.get_issue(repo, number)
            body: str = issue.get("body") or ""
            deps = _parse_depends_on(body)
            if deps:
                logger.debug(
                    "get_issue_dependencies: body-parsed deps=%s for %s#%d",
                    deps,
                    repo,
                    number,
                )
                return deps
        except requests.RequestException as exc:
            logger.warning(
                "get_issue_dependencies: could not fetch issue body for %s#%d: %s",
                repo,
                number,
                exc,
            )

        return []


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _run_git(cmd: list[str], cwd: str) -> str:
    """Run a git command in *cwd* and return its stdout.

    Args:
        cmd: Command list, e.g. ``["git", "fetch", "origin"]``.
        cwd: Working directory for the subprocess.

    Returns:
        The stdout output as a string.

    Raises:
        RuntimeError: If the git command exits with a non-zero status,
            including the stderr output in the message.
    """
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"git command failed: {' '.join(cmd)}\nstderr: {result.stderr}"
        )
    return result.stdout


def _parse_next_link(link_header: str) -> Optional[str]:
    """Extract the ``rel="next"`` URL from a GitHub ``Link`` response header.

    GitHub paginates list endpoints by embedding a ``Link`` header with
    ``rel="next"`` pointing to the subsequent page. Returns ``None`` when
    there are no further pages.

    Args:
        link_header: Raw value of the ``Link`` HTTP response header, or an
            empty string when the header is absent.

    Returns:
        The URL string for the next page, or ``None``.
    """
    # Each entry in the Link header looks like: <url>; rel="next"
    for part in link_header.split(","):
        part = part.strip()
        match = re.match(r'<([^>]+)>;\s*rel="next"', part)
        if match:
            return match.group(1)
    return None


def _parse_depends_on(body: str) -> list[int]:
    """Parse ``Depends-on: #N`` lines from an issue body.

    Recognizes patterns such as:
    - ``Depends-on: #12``
    - ``Depends-on: #12, #34``
    - ``Depends-on: #12, #34, #56``

    The match is case-insensitive and handles optional whitespace around
    issue number references.

    Args:
        body: Raw issue body text.

    Returns:
        A list of referenced issue numbers, preserving order of appearance.
        Duplicates are removed while keeping first occurrence.
    """
    deps: list[int] = []
    seen: set[int] = set()
    # Match a "Depends-on:" line followed by one or more #N references.
    pattern = re.compile(r"(?i)depends-on:\s*((?:#\d+(?:\s*,\s*)?)+)")
    for match in pattern.finditer(body):
        # Extract individual issue numbers from the matched group.
        for num_match in re.finditer(r"#(\d+)", match.group(1)):
            n = int(num_match.group(1))
            if n not in seen:
                seen.add(n)
                deps.append(n)
    return deps
