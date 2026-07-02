# Hive

A personal tool to deploy agents remotely and activate them via external triggers (GitHub webhooks, issue labels, etc.).

Primary use case: add the label `agent:develop` to a GitHub issue, a remote agent reads it, implements the change, and opens a PR for human review. No manual intervention between trigger and result.

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

## Install

**Global install (CLI only)**

Install the `hive` CLI globally with `pipx` so it is available from any project directory:

```bash
pipx install .
```

Or with plain pip into a virtual environment:

```bash
pip install .
```

This exposes the `hive` command. Run `hive --help` to confirm.

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

> The URL changes every time localtunnel restarts. Update the GitHub webhook URL when that happens. For a stable URL, use a VPS (Phase 5).

**4. Configure the GitHub webhook**

Go to your repo → Settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `https://your-tunnel-url.loca.lt/webhook` |
| Content type | `application/json` |
| Secret | same value as `GITHUB_WEBHOOK_SECRET` in `.env` |
| Events | Issues (at minimum) |

**5. Trigger an agent**

Apply the label `agent:develop` to any issue. The agent will clone the repo, implement the change, and open a PR within ~60 seconds.

---

## `hive run` — batch execution

Run all open issues carrying a given label in dependency order:

```bash
hive run --project <label>
```

Fetches every open issue with `<label>`, resolves the dependency order that Chisel wrote at issue-creation time, and executes Cody → Reven per issue sequentially. No LLM orchestrator at runtime — deterministic loop.

```bash
# Run all issues labelled "my-feature" in the current repo
hive run --project my-feature

# Target a specific repository
hive run --project my-feature --repo owner/repo
```

**Repository resolution order:**

1. `--repo` flag (per-invocation override)
2. `GITHUB_REPO` environment variable
3. `git remote get-url origin` (auto-detected from the current directory)

**Machine-level secrets (recommended one-time setup):**

```bash
mkdir -p ~/.hive
cat > ~/.hive/.env << 'EOF'
GITHUB_TOKEN=ghp_your_token_here
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token_here
EOF
chmod 600 ~/.hive/.env
```

With this in place, `hive run --project my-label` works from any project directory without exporting tokens in the shell.

---

## Label model (Phase 4)

Labels are owned by the orchestrator except for the two manual entry points. Humans never apply labels mid-flow to steer — that's what PR comments are for.

| Label | Applied by | Meaning |
|---|---|---|
| `agent:analyze` | Human (manual) | Analyze an issue before deciding to develop |
| `agent:develop` | Human (manual) | Implement a single issue (Cody) |
| `agent:review` | Orchestrator | Reven reviews the PR (auto-applied after Cody opens it) |
| `human:review` | Orchestrator | Agent failed unrecoverably — human must inspect logs |

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
    label: "agent:analyze"
system_prompt: |
  You are a senior software engineer...
```

Add new agents by dropping a `.yaml` file in `agents/`. The label-to-agent mapping lives in `runner/main.py`:

```python
# agent:analyze  →  issue-reviewer.yaml
# agent:develop  →  cody.yaml
# agent:review   →  reven.yaml  (applied automatically by the orchestrator)
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes (Docker/webhook) | HMAC secret shared with GitHub webhook |
| `GITHUB_TOKEN` | Yes | PAT for cloning repos and posting comments |
| `CLAUDE_CODE_OAUTH_TOKEN` | For `runner: claude-code` | Obtained via `claude setup-token` |
| `OPENAI_API_KEY` | For `runner: codex` | OpenAI key for Codex runner |
| `GITHUB_OWNER` | Yes (CLI) | GitHub username of the repo owner |
| `GITHUB_REPO` | No | Target repo in `owner/repo` format (auto-detected if unset) |

---

## Layered env resolution (CLI)

The `hive` CLI is installed globally (via `pipx`) and runs from arbitrary project directories, so it uses a three-layer env resolution strategy instead of relying on a single `.env` location.

**Priority order (highest → lowest):**

| Layer | Source | Typical contents |
|---|---|---|
| 1 | `os.environ` / shell exports | CI secrets, manually exported vars — **always win** |
| 2 | `.env` in the current working directory | Per-project config: `GITHUB_OWNER`, `GITHUB_REPO` |
| 3 | `~/.hive/.env` | Machine-level secrets: `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |

Values already present in `os.environ` are **never overwritten** by either file. A variable in the cwd `.env` takes precedence over the same variable in `~/.hive/.env`. Both files are optional; missing files are silently skipped.

> **Docker / Compose:** The webhook server reads the repo-root `.env` via `env_file` in `docker-compose.yml` and is **not** affected by this layering.

---

## Development phases

| Phase | Status | Description |
|---|---|---|
| 1 | Done | Webhook receiver — receive, verify, log |
| 2 | Done | `issue-reviewer` agent — `agent:analyze` triggers analysis comment |
| 3 | Done | `issue-developer` → replaced by Cody (`agent:develop` triggers branch + PR) |
| 4 | Done | Agent integration (Cody + Reven), `hive run` batch command, comment-driven rework |
| 5 | Planned | VPS deploy (Hetzner) — stable public URL, no localtunnel |

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
