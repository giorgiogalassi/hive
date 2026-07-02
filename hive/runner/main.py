"""
main.py — FastAPI webhook receiver for the Hive GitHub automation system.

Listens for inbound GitHub webhook events, validates their HMAC-SHA256 signature
to confirm they originate from GitHub, and dispatches the appropriate agent as a
background task based on the normalized event type returned by the VCS port.

All event parsing and VCS operations are delegated to the GitHubAdapter so that
no GitHub-specific webhook field names appear outside the adapter.  The one
exception is the HMAC signature header ``X-Hub-Signature-256``, which must be
read directly here as part of the security infrastructure before any event
parsing takes place.
"""

import hashlib
import hmac
import importlib.resources
import logging
import os

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from hive.runner import agent_runner
from hive.runner import loop
from hive.runner.vcs.github_adapter import GitHubAdapter
from hive.runner.vcs.port import (
    IssueCommentEvent,
    IssueLabeledEvent,
    PRLabeledEvent,
    PROpenedEvent,
    PRReviewSubmittedEvent,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# The shared secret configured in the GitHub repository's webhook settings.
# Required at startup: the server refuses to run without it because every
# incoming request must be signature-verified before processing.
_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET")
if not _SECRET:
    raise RuntimeError(
        "GITHUB_WEBHOOK_SECRET environment variable is not set. "
        "The webhook receiver cannot start without it."
    )

# Pre-encode the secret once so every request can compute the HMAC digest
# without repeatedly encoding the same string.
_SECRET_BYTES: bytes = _SECRET.encode()

# Single VCS adapter instance shared across all requests.  GitHubAdapter owns
# all GitHub-specific field names; nothing else in this module may reference
# provider-specific payload keys.
_vcs = GitHubAdapter()

app = FastAPI()


def _agent_yaml(name: str) -> str:
    """Return the filesystem path to a bundled agent YAML file.

    Uses ``importlib.resources`` so the path resolves correctly whether the
    server is run from a source checkout or from a global ``pip install``.

    Args:
        name: Filename of the YAML file (e.g. ``"cody.yaml"``).

    Returns:
        Absolute path string to the YAML file inside the installed package.
    """
    return str(importlib.resources.files("hive.agents").joinpath(name))


@app.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    """Handle an inbound GitHub webhook POST request.

    Performs the following steps in order:

    1. **Signature validation** — Computes the expected HMAC-SHA256 digest of
       the raw request body using the shared webhook secret and compares it to
       the ``X-Hub-Signature-256`` header supplied by GitHub.  Requests that
       are missing the header or whose digest does not match are rejected with
       HTTP 401.

    2. **Event parsing** — Delegates payload interpretation to
       :meth:`~hive.runner.vcs.github_adapter.GitHubAdapter.parse_event`, which
       returns a normalized event object or ``None`` for unhandled event types.

    3. **Dispatch** — Switches on the concrete type of the normalized event and
       schedules the appropriate agent as a FastAPI background task:

       - :class:`~hive.runner.vcs.port.IssueLabeledEvent` with ``agent:analyze``
         → dispatches ``issue-reviewer.yaml``.
       - :class:`~hive.runner.vcs.port.IssueLabeledEvent` with ``agent:develop``
         → dispatches ``cody.yaml``.
       - :class:`~hive.runner.vcs.port.PROpenedEvent`
         → idempotently applies the ``agent:review`` label so the resulting
         :class:`~hive.runner.vcs.port.PRLabeledEvent` fires Reven.
       - :class:`~hive.runner.vcs.port.PRLabeledEvent` with ``agent:review``
         → dispatches ``reven.yaml`` via :func:`agent_runner.run_for_pr`.
       - :class:`~hive.runner.vcs.port.PRReviewSubmittedEvent`
         → delegates to :func:`loop.on_review_submitted`; re-queues
         ``cody.yaml`` on ``"requeue"``, logs on ``"approved"`` /
         ``"human_review"``.
       - :class:`~hive.runner.vcs.port.IssueCommentEvent` on a PR from the repo
         owner → delegates to :func:`loop.on_owner_comment`; re-queues
         ``cody.yaml`` on ``"requeue"``.

    Args:
        request: The incoming FastAPI request object containing headers and body.
        background_tasks: FastAPI dependency used to schedule the agent run after
            the HTTP response has been sent.

    Returns:
        A JSON response with ``{"status": "ok"}`` on success, or a plain-text
        error message with HTTP 401 if signature validation fails.
    """
    # Read the raw bytes before any parsing so the HMAC is computed over the
    # exact bytes that GitHub signed, not a re-serialised version of the payload.
    body: bytes = await request.body()

    # --- Signature validation ---
    # The X-Hub-Signature-256 header is read here intentionally: it is security
    # infrastructure that must run before any event parsing, not a business-logic
    # payload field.  This is the only GitHub-specific string permitted in main.py.
    signature_header = request.headers.get("X-Hub-Signature-256")
    if not signature_header:
        return PlainTextResponse(
            content="Missing X-Hub-Signature-256 header",
            status_code=401,
        )

    expected_digest = (
        "sha256="
        + hmac.new(_SECRET_BYTES, body, hashlib.sha256).hexdigest()
    )

    # Use hmac.compare_digest to prevent timing attacks that could reveal the
    # secret by measuring how long a byte-by-byte comparison takes.
    if not hmac.compare_digest(expected_digest, signature_header):
        return PlainTextResponse(
            content="Invalid signature",
            status_code=401,
        )

    # --- Event parsing via VCS port ---
    # parse_event returns None for ping events and any other unhandled types;
    # we acknowledge them with 200 without further processing.
    event = _vcs.parse_event(dict(request.headers), body)

    if event is None:
        logger.info("parse_event returned None — unhandled or ping event, acknowledging")
        return JSONResponse(content={"status": "ok"}, status_code=200)

    logger.info("event=%s", type(event).__name__)

    github_token = os.environ.get("GITHUB_TOKEN", "")

    # --- Dispatch on normalized event type ---

    if isinstance(event, IssueLabeledEvent):
        _dispatch_issue_labeled(event, github_token, background_tasks)

    elif isinstance(event, PROpenedEvent):
        _handle_pr_opened(event)

    elif isinstance(event, PRLabeledEvent):
        _dispatch_pr_labeled(event, github_token, background_tasks)

    elif isinstance(event, PRReviewSubmittedEvent):
        _handle_review_submitted(event, github_token, background_tasks)

    elif isinstance(event, IssueCommentEvent) and event.is_pr:
        _handle_owner_pr_comment(event, github_token, background_tasks)

    return JSONResponse(content={"status": "ok"}, status_code=200)


# ---------------------------------------------------------------------------
# Private dispatch helpers
# ---------------------------------------------------------------------------


def _dispatch_issue_labeled(
    event: IssueLabeledEvent,
    github_token: str,
    background_tasks: BackgroundTasks,
) -> None:
    """Dispatch an agent when a label is applied to an issue.

    Fetches the issue title and body via the VCS port so the agent receives
    the full context it needs, then schedules the appropriate YAML runner as
    a background task.

    Args:
        event: Normalized issue-labeled event.
        github_token: GitHub personal access token injected into the agent context.
        background_tasks: FastAPI background task registry.
    """
    if event.label not in ("agent:analyze", "agent:develop"):
        logger.debug("IssueLabeledEvent: unhandled label=%s — ignoring", event.label)
        return

    # Fetch the issue details so the agent receives useful context.
    try:
        issue_details = _vcs.get_issue(event.repo, event.issue_number)
    except Exception:
        logger.exception(
            "IssueLabeledEvent: could not fetch issue details for %s#%d",
            event.repo, event.issue_number,
        )
        issue_details = {"title": "", "body": ""}

    context = {
        "repo_full_name": event.repo,
        "issue_number": event.issue_number,
        "issue_title": issue_details.get("title", ""),
        "issue_body": issue_details.get("body", ""),
        "label": event.label,
        "github_token": github_token,
    }

    if event.label == "agent:analyze":
        agent_yaml = "issue-reviewer.yaml"
    else:
        # "agent:develop"
        agent_yaml = "cody.yaml"

    yaml_path = _agent_yaml(agent_yaml)
    logger.info(
        "dispatching label=%s agent=%s issue=#%d repo=%s",
        event.label, agent_yaml, event.issue_number, event.repo,
    )
    background_tasks.add_task(agent_runner.run, yaml_path, context)


def _handle_pr_opened(event: PROpenedEvent) -> None:
    """Idempotently apply the ``agent:review`` label when a PR is opened.

    The label application triggers a ``PRLabeledEvent`` webhook, which then
    fires Reven.  No agent is dispatched directly from this handler.

    Args:
        event: Normalized PR-opened event.
    """
    try:
        already_labeled = _vcs.has_label(event.repo, event.pr_number, "agent:review")
    except Exception:
        logger.exception(
            "PROpenedEvent: could not check labels for %s#%d",
            event.repo, event.pr_number,
        )
        return

    if not already_labeled:
        try:
            _vcs.apply_label(event.repo, event.pr_number, "agent:review")
            logger.info(
                "PROpenedEvent: applied agent:review to pr=#%d repo=%s",
                event.pr_number, event.repo,
            )
        except Exception:
            logger.exception(
                "PROpenedEvent: could not apply agent:review to %s#%d",
                event.repo, event.pr_number,
            )
    else:
        logger.debug(
            "PROpenedEvent: agent:review already present on pr=#%d repo=%s",
            event.pr_number, event.repo,
        )


def _dispatch_pr_labeled(
    event: PRLabeledEvent,
    github_token: str,
    background_tasks: BackgroundTasks,
) -> None:
    """Dispatch Reven when the ``agent:review`` label is applied to a PR.

    Fetches PR metadata (title, body) via the VCS port and builds the full
    PR context required by :func:`agent_runner.run_for_pr`.  Head and base
    branches are left empty because GitHub's issues API endpoint does not
    return branch information for pull requests.

    Args:
        event: Normalized PR-labeled event.
        github_token: GitHub personal access token injected into the agent context.
        background_tasks: FastAPI background task registry.
    """
    if event.label != "agent:review":
        logger.debug("PRLabeledEvent: unhandled label=%s — ignoring", event.label)
        return

    # Use the issues endpoint (works for PR numbers too) to retrieve title/body.
    try:
        pr_details = _vcs.get_issue(event.repo, event.pr_number)
    except Exception:
        logger.exception(
            "PRLabeledEvent: could not fetch PR details for %s#%d",
            event.repo, event.pr_number,
        )
        pr_details = {"title": "", "body": ""}

    pr_context = {
        "repo_full_name": event.repo,
        "pr_number": event.pr_number,
        "pr_title": pr_details.get("title", ""),
        "pr_body": pr_details.get("body", ""),
        "head_branch": "",
        "base_branch": "",
        "review_body": "",
        "github_token": github_token,
    }

    yaml_path = _agent_yaml("reven.yaml")
    logger.info(
        "dispatching label=%s agent=reven.yaml pr=#%d repo=%s",
        event.label, event.pr_number, event.repo,
    )
    background_tasks.add_task(agent_runner.run_for_pr, yaml_path, pr_context, _vcs)


def _handle_review_submitted(
    event: PRReviewSubmittedEvent,
    github_token: str,
    background_tasks: BackgroundTasks,
) -> None:
    """Act on the outcome of a PR review submission.

    Delegates the loop decision to :func:`loop.on_review_submitted` and
    re-queues Cody when the result is ``"requeue"``.

    Args:
        event: Normalized PR-review-submitted event.
        github_token: GitHub personal access token injected into the agent context.
        background_tasks: FastAPI background task registry.
    """
    result = loop.on_review_submitted(_vcs, event)

    if result == "requeue":
        pr_context = {
            "repo_full_name": event.repo,
            "pr_number": event.pr_number,
            "pr_title": "",
            "pr_body": "",
            "head_branch": "",
            "base_branch": "",
            "review_body": event.body,
            "github_token": github_token,
        }
        yaml_path = _agent_yaml("cody.yaml")
        logger.info(
            "PRReviewSubmittedEvent: requeuing cody.yaml for pr=#%d repo=%s",
            event.pr_number, event.repo,
        )
        background_tasks.add_task(agent_runner.run_for_pr, yaml_path, pr_context, _vcs)

    elif result == "approved":
        logger.info(
            "PRReviewSubmittedEvent: pr=#%d approved — no action required",
            event.pr_number,
        )

    elif result == "human_review":
        logger.info(
            "PRReviewSubmittedEvent: pr=#%d escalated to human review — label already applied",
            event.pr_number,
        )


def _handle_owner_pr_comment(
    event: IssueCommentEvent,
    github_token: str,
    background_tasks: BackgroundTasks,
) -> None:
    """Re-queue Cody when the repo owner comments on a PR.

    Checks :func:`loop.is_repo_owner` to confirm the commenter is the owner
    configured via ``GITHUB_OWNER``, then delegates to
    :func:`loop.on_owner_comment` for the loop-state decision.

    Args:
        event: Normalized issue-comment event where ``is_pr`` is ``True``.
        github_token: GitHub personal access token injected into the agent context.
        background_tasks: FastAPI background task registry.
    """
    if not loop.is_repo_owner(event.author):
        logger.debug(
            "IssueCommentEvent: author=%s is not repo owner — ignoring",
            event.author,
        )
        return

    result = loop.on_owner_comment(event)

    if result == "requeue":
        pr_context = {
            "repo_full_name": event.repo,
            "pr_number": event.number,
            "pr_title": "",
            "pr_body": "",
            "head_branch": "",
            "base_branch": "",
            "review_body": event.body,
            "github_token": github_token,
        }
        yaml_path = _agent_yaml("cody.yaml")
        logger.info(
            "IssueCommentEvent: owner requeue cody.yaml for pr=#%d repo=%s",
            event.number, event.repo,
        )
        background_tasks.add_task(agent_runner.run_for_pr, yaml_path, pr_context, _vcs)
    else:
        logger.debug(
            "IssueCommentEvent: owner comment on pr=#%d — loop returned ignore",
            event.number,
        )
