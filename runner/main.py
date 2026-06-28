"""
main.py — FastAPI webhook receiver for the Hive GitHub automation system.

Listens for inbound GitHub webhook events, validates their HMAC-SHA256 signature
to confirm they originate from GitHub, and dispatches the appropriate agent as a
background task when a matching issue label is applied.
"""

import hashlib
import hmac
import json
import logging
import os

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from runner import agent_runner

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

# Resolve the agents directory relative to this file so the path stays correct
# regardless of the working directory from which the server is launched.
_AGENTS_DIR = os.path.join(os.path.dirname(__file__), "..", "agents")

# Map each trigger label to the agent YAML filename.
# To add a new agent, insert its label and corresponding YAML filename here.
_LABEL_TO_AGENT: dict[str, str] = {
    "agent:review": "issue-reviewer.yaml",
    "agent:develop": "issue-developer.yaml",
}

app = FastAPI()


@app.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    """Handle an inbound GitHub webhook POST request.

    Performs the following steps in order:
    1. **Signature validation** — Computes the expected HMAC-SHA256 digest of the
       raw request body using the shared webhook secret and compares it to the
       ``X-Hub-Signature-256`` header supplied by GitHub. Requests that are missing
       the header or whose digest does not match are rejected with HTTP 401.
    2. **Event routing** — Inspects the ``X-GitHub-Event`` and ``action`` fields to
       decide what to do:
       - ``ping`` events are acknowledged immediately (used by GitHub when a
         webhook is first created or re-delivered).
       - ``issues`` / ``labeled`` events trigger agent dispatch (see below).
       - All other event types are silently accepted with ``{"status": "ok"}``.
    3. **Agent dispatch** — When an issue is labeled, the label name is looked up in
       ``_LABEL_TO_AGENT``. If a matching YAML config is found, the relevant GitHub
       context (repo, issue number, title, body, token) is assembled and passed to
       :func:`agent_runner.run` as a FastAPI background task so the HTTP response
       is returned immediately without waiting for the (potentially long-running)
       agent to finish.

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

    # --- Event routing ---
    payload: dict = json.loads(body)
    event_type: str = request.headers.get("X-GitHub-Event", "unknown")
    action: str | None = payload.get("action")

    logger.info("event=%s action=%s", event_type, action)

    # Acknowledge GitHub's connectivity check sent when a webhook is registered.
    if event_type == "ping":
        return JSONResponse(content={"status": "ok"}, status_code=200)

    # Only ``issues`` events with an ``labeled`` action can trigger an agent.
    if event_type == "issues" and action == "labeled":
        label_name: str = payload.get("label", {}).get("name", "")
        agent_yaml = _LABEL_TO_AGENT.get(label_name)

        if agent_yaml:
            # Extract the minimal set of GitHub context fields the agent needs
            # to identify the repository and issue it should work on.
            issue = payload.get("issue", {})
            repo = payload.get("repository", {})
            github_token = os.environ.get("GITHUB_TOKEN", "")

            context = {
                "repo_full_name": repo.get("full_name", ""),
                "issue_number": issue.get("number"),
                "issue_title": issue.get("title", ""),
                "issue_body": issue.get("body", ""),
                "label": label_name,
                "github_token": github_token,
            }

            yaml_path = os.path.join(_AGENTS_DIR, agent_yaml)
            logger.info("dispatching label=%s agent=%s issue=#%s", label_name, agent_yaml, context["issue_number"])
            # Schedule the agent as a background task so the webhook response is
            # returned to GitHub immediately; agents can run for several minutes.
            background_tasks.add_task(agent_runner.run, yaml_path, context)

    return JSONResponse(content={"status": "ok"}, status_code=200)
