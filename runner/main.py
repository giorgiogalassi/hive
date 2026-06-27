import hashlib
import hmac
import json
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Fail fast at startup if the secret is not configured.
_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET")
if not _SECRET:
    raise RuntimeError(
        "GITHUB_WEBHOOK_SECRET environment variable is not set. "
        "The webhook receiver cannot start without it."
    )

_SECRET_BYTES: bytes = _SECRET.encode()

app = FastAPI()


@app.post("/webhook")
async def webhook(request: Request) -> JSONResponse:
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

    logger.info(
        "event=%s action=%s payload=%s",
        event_type,
        action,
        body.decode(),
    )

    if event_type == "ping":
        logger.info("ping received")
        return JSONResponse(content={"status": "ok"}, status_code=200)

    return JSONResponse(content={"status": "ok"}, status_code=200)
