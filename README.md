# Hive

A personal tool to deploy agents remotely and activate them via external triggers (GitHub webhooks, issue labels, etc.).

Primary use case: add the label `agent:review` to a GitHub issue, a remote agent reads it, analyzes feasibility, and posts a structured comment. No manual intervention between trigger and result.

---

## How it works

```
Label added on GitHub issue
        ↓
Hive receives the webhook (FastAPI)
        ↓
Verifies HMAC-SHA256 signature
        ↓
Loads the matching agent YAML
        ↓
Agent runs, uses tools (bash, read, write)
        ↓
Agent posts result back to GitHub
```

---

## Project structure

```
hive/
  agents/                     agent YAML definitions
  skills/                     Python tool definitions
  runner/
    main.py                   FastAPI app + webhook receiver
    agent_runner.py           loads YAML, instantiates agent, starts run
    llm_port.py               LLMPort abstract interface
    adapters/
      anthropic_adapter.py
      openai_adapter.py
    tools/
      bash_tool.py
      read_tool.py
      write_tool.py
  Dockerfile
  docker-compose.yml
  .env.example
```

---

## Requirements

- Docker + Docker Compose
- A GitHub repo with webhook access
- An Anthropic API key (Phase 2+)

For local tunnel testing:
- Node.js (for `npx localtunnel`)

---

## Setup

**1. Clone and configure environment**

```bash
cp .env.example .env
```

Edit `.env` and set:

```
GITHUB_WEBHOOK_SECRET=your-secret-here
```

Use any random string. You will paste the same value into the GitHub webhook settings.

**2. Start the receiver**

```bash
docker compose up
```

The app starts on `http://localhost:8000`. You should see:

```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

**3. Expose localhost via localtunnel**

In a second terminal:

```bash
npx localtunnel --port 8000
```

This prints a public HTTPS URL (e.g. `https://fast-ears-rest.loca.lt`). Copy it.

> Note: the URL changes every time localtunnel restarts. Update the GitHub webhook URL when that happens. For a stable URL, use a VPS (Phase 4).

**4. Configure the GitHub webhook**

Go to your repo → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `https://your-tunnel-url.loca.lt/webhook` |
| Content type | `application/json` |
| Secret | same value as `GITHUB_WEBHOOK_SECRET` in `.env` |
| Events | Issues (at minimum) |

**5. Test**

Add any label to any issue in your repo. You should see the JSON payload appear in `docker compose` logs within a second.

---

## Running without Docker

If you prefer to run directly with Python:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn runner.main:app --reload
```

The app behaves identically. Docker is used in production for portability, isolation, and the ability to run multiple agents in parallel as separate containers.

---

## Development phases

| Phase | Status | Description |
|---|---|---|
| 1 | Done | Webhook receiver — receive, verify, log |
| 2 | Planned | `issue-reviewer` agent — label triggers analysis comment |
| 3 | Planned | `issue-developer` agent — label triggers branch + PR |
| 4 | Planned | `hive` CLI + Hetzner VPS deploy |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes | HMAC secret shared with GitHub webhook |
| `ANTHROPIC_API_KEY` | Phase 2+ | API key for the Anthropic SDK |
| `GITHUB_TOKEN` | Phase 2+ | PAT for posting comments and opening PRs |
