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

_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET")
if not _SECRET:
    raise RuntimeError(
        "GITHUB_WEBHOOK_SECRET environment variable is not set. "
        "The webhook receiver cannot start without it."
    )

_SECRET_BYTES: bytes = _SECRET.encode()

_AGENTS_DIR = os.path.join(os.path.dirname(__file__), "..", "agents")

# Map each trigger label to the agent YAML filename.
_LABEL_TO_AGENT: dict[str, str] = {
    "agent:review": "issue-reviewer.yaml",
    "agent:develop": "issue-developer.yaml",
}

app = FastAPI()


@app.post("/webhook")
async def webhook(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    body: bytes = await request.body()

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

    if not hmac.compare_digest(expected_digest, signature_header):
        return PlainTextResponse(
            content="Invalid signature",
            status_code=401,
        )

    payload: dict = json.loads(body)
    event_type: str = request.headers.get("X-GitHub-Event", "unknown")
    action: str | None = payload.get("action")

    logger.info("event=%s action=%s", event_type, action)

    if event_type == "ping":
        return JSONResponse(content={"status": "ok"}, status_code=200)

    if event_type == "issues" and action == "labeled":
        label_name: str = payload.get("label", {}).get("name", "")
        agent_yaml = _LABEL_TO_AGENT.get(label_name)

        if agent_yaml:
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
            background_tasks.add_task(agent_runner.run, yaml_path, context)

    return JSONResponse(content={"status": "ok"}, status_code=200)
