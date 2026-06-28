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
Clones the repo into a temp workdir
        ↓
Invokes the agent runtime (claude --print ...)
        ↓
Agent posts result back to GitHub via curl
```

---

## Project structure

```
hive/
  agents/                     agent YAML definitions
  runner/
    main.py                   FastAPI app + webhook receiver
    agent_runner.py           loads YAML, clones repo, invokes CLI runner
  Dockerfile
  docker-compose.yml
  .env.example
```

---

## Requirements

- Docker + Docker Compose
- A GitHub repo with webhook access
- Claude Code CLI credentials (`claude setup-token`)

For local tunnel testing:
- Node.js (for `npx localtunnel`)

---

## Setup

**1. Clone and configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
GITHUB_WEBHOOK_SECRET=your-secret-here
GITHUB_TOKEN=your-github-pat
CLAUDE_CODE_OAUTH_TOKEN=<output of: claude setup-token>
```

**2. Start the stack**

```bash
docker compose up --build
```

The app starts on `http://localhost:8000`.

**3. Expose localhost via localtunnel**

```bash
npx localtunnel --port 8000
```

This prints a public HTTPS URL (e.g. `https://fast-ears-rest.loca.lt`). Copy it.

> The URL changes every time localtunnel restarts. Update the GitHub webhook URL when that happens. For a stable URL, use a VPS (Phase 4).

**4. Configure the GitHub webhook**

Go to your repo → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `https://your-tunnel-url.loca.lt/webhook` |
| Content type | `application/json` |
| Secret | same value as `GITHUB_WEBHOOK_SECRET` in `.env` |
| Events | Issues (at minimum) |

**5. Trigger an agent**

Apply the label `agent:review` to any issue. The agent will clone the repo, analyze the issue, and post a comment within ~60 seconds.

---

## Agent YAML format

```yaml
name: issue-reviewer
runner: claude-code          # claude-code | codex
model:
  provider: anthropic
  name: claude-sonnet-4-6
triggers:
  - type: github-label
    label: "agent:review"
system_prompt: |
  You are a senior software engineer...
```

Add new agents by dropping a `.yaml` file in `agents/` and registering the label in `runner/main.py`:

```python
_LABEL_TO_AGENT: dict[str, str] = {
    "agent:review": "issue-reviewer.yaml",
    "agent:develop": "issue-developer.yaml",  # example
}
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes | HMAC secret shared with GitHub webhook |
| `GITHUB_TOKEN` | Yes | PAT for cloning repos and posting comments |
| `CLAUDE_CODE_OAUTH_TOKEN` | For `runner: claude-code` | Obtained via `claude setup-token` |
| `OPENAI_API_KEY` | For `runner: codex` | OpenAI key for Codex runner |

---

## Development phases

| Phase | Status | Description |
|---|---|---|
| 1 | Done | Webhook receiver — receive, verify, log |
| 2 | In progress | `issue-reviewer` agent — label triggers analysis comment |
| 3 | Planned | `issue-developer` agent — label triggers branch + PR |
| 4 | Planned | VPS deploy (Hetzner) |

---

## Debugging

**Follow live logs**

```bash
docker compose logs -f
```

**Check recent logs (last 50 lines)**

```bash
docker logs hive-app-1 --tail 50
```

**Open a shell inside the container**

```bash
docker exec -it hive-app-1 bash
```

**Verify claude CLI is authenticated**

```bash
docker exec hive-app-1 claude --print "say hello in one sentence"
```

**Run claude manually with a model and system prompt (no TTY)**

```bash
docker exec hive-app-1 claude --print --model claude-sonnet-4-6 --system-prompt "Be concise." "List files in the current directory"
```

**Inspect a running container's processes**

```bash
docker exec hive-app-1 ps aux
```

**List all running containers**

```bash
docker ps
```

**Rebuild and restart cleanly**

```bash
docker compose down && docker compose up --build
```

**Rebuild in background**

```bash
docker compose up --build -d
```
