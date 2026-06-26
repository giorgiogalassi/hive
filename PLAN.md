# Hive — Development Plan

Giorgio Galassi | 2026

---

## Goal

Build Hive, a personal open source tool to deploy agents remotely
and activate them via external triggers (GitHub webhooks, issue labels, etc.).

Primary use case: add the label `agent:review` to a GitHub issue,
a remote agent reads it, analyzes feasibility, and posts a structured comment.
No manual intervention between trigger and result.

Claude Code usage: brainstorming and planning only. Execution is handled
by the remote agents.

---

## Decided Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Webhook receiver | FastAPI (Python) | Lightweight, async, good for learning |
| Agent runtime | Anthropic SDK + LiteLLM | Direct SDK + provider abstraction |
| Provider abstraction | LiteLLM | Normalizes tool calls across Anthropic/OpenAI/Ollama |
| Agent config | Custom declarative YAML | Versionable, readable, not tied to any framework |
| Containerization | Docker + Docker Compose | Full portability, deploy anywhere |
| Deploy CLI | `hive` (minimal Python script) | 3 commands: deploy, list, remove |
| Local dev tunnel | localtunnel (current) / ngrok / Cloudflare Tunnel | Local testing without external infrastructure. Using localtunnel (`npx localtunnel --port 8000`) — no account needed. Downside: URL changes on restart, requires updating the GitHub webhook. Migrate to a stable URL in Phase 4. |
| Hosting (future) | Hetzner VPS + Cloudflare DNS | ~6 EUR/month, fixed IP, zero vendor lock-in |
| GitHub auth | PAT with limited scopes (then GitHub App) | Separate identity for the agent |

### Agent capabilities (MVP)

Three base tools, always available, nothing else for now:

- `bash` / shell
- `read` (filesystem)
- `write` (filesystem)

Network access: open question. Docker containers have network access by default.
Restriction to be added after the first working agent.

---

## Project Structure

```text
hive/
  agents/                     agent YAML definitions
    issue-reviewer.yaml
    issue-developer.yaml
  skills/                     Python skills (tool definitions) — empty for now
  runner/                     system core
    main.py                   FastAPI app + webhook receiver
    agent_runner.py           loads YAML, instantiates agent, starts run
    llm_port.py               LLMPort (abstract interface)
    adapters/
      anthropic_adapter.py
      openai_adapter.py
      ollama_adapter.py       (future)
    tools/
      bash_tool.py
      read_tool.py
      write_tool.py
  hive                        minimal CLI (Python script)
  docker-compose.yml
  Dockerfile
  .env.example                environment variable template
  README.md
```

### Agent YAML format

```yaml
name: issue-reviewer
description: Analyzes an issue and evaluates feasibility

model:
  provider: anthropic
  name: claude-haiku-4-5

triggers:
  - type: github-label
    label: agent:review

system_prompt: |
  You are a senior engineer. Read the issue, evaluate feasibility,
  identify the files involved, and post a structured comment.
```

To switch provider: change `model.provider` and `model.name`, redeploy.
The agent code does not change.

---

## Development Phases

### Phase 1 — Working webhook receiver (minimum MVP)

Goal: receive a GitHub webhook, log it, respond 200.
No agent yet. Just the network round-trip.

Deliverables:
- FastAPI app with `/webhook` endpoint
- HMAC signature verification (basic security)
- Incoming payload logging
- Docker Compose running everything locally
- ngrok to expose localhost and test with real GitHub

Definition of done: assign a label to a real issue,
see the payload logged in the container.

---

### Phase 2 — `issue-reviewer` agent (full MVP)

Goal: `agent:review` label on an issue triggers the agent.
The agent posts a comment on the issue.

Flow:

```
Label "agent:review" added
        ↓
FastAPI receives webhook, extracts issue number + label
        ↓
Loads agents/issue-reviewer.yaml
        ↓
Agent runner:
  - clones repo to a temp directory (bash tool)
  - reads issue text (GitHub REST API via bash: curl)
  - passes everything to the LLM with system prompt from YAML
  - LLM reasons, uses read tool to read relevant files
        ↓
Agent posts comment on the issue via GitHub API
        ↓
Temp directory deleted
```

Deliverables:
- LLMPort + AnthropicAdapter + LiteLLM
- Bash tool, Read tool, Write tool
- Agent runner that loads YAML dynamically
- GitHub token as environment variable
- End-to-end test: real issue, real comment

Definition of done: add label, receive agent comment within 60 seconds.

---

### Phase 3 — `issue-developer` agent

Goal: `agent:develop` label triggers development and PR opening.

Additional flow on top of Phase 2:

```
Agent reads issue + any previous analysis comment
        ↓
Creates branch: agent/issue-{N}-{slug}
        ↓
Writes code (write tool + bash for git operations)
        ↓
git commit + git push
        ↓
Opens PR linked to the issue
        ↓
You review
```

Required guardrails before this phase:
- Agent never touches `main` directly
- Every run works in an isolated temp directory
- PR requires human review before merge

---

### Phase 4 — `hive` CLI and VPS deploy

Goal: move off ngrok, have a stable deploy.

```bash
hive deploy agents/issue-reviewer.yaml
hive list
hive remove issue-reviewer
hive deploy agents/issue-reviewer.yaml --provider openai --model gpt-4o
```

Deliverables:
- `hive` Python script (~150-200 lines)
- Deploy to Hetzner VPS via Docker Compose
- Cloudflare DNS for a stable URL
- GitHub webhook pointing to the VPS URL

---

## Open Questions

### Container network access
Docker gives containers internet access by default. Decide whether to
isolate (network: none) or allow controlled access with a whitelist.
Impact: agent can or cannot curl external APIs via bash.
To be decided after Phase 2 is working.

### GitHub App vs PAT
PAT is sufficient for personal use. GitHub App gives a separate audit log
(commits and comments appear as "agent-name[bot]" instead of you)
and granular per-repo permissions. Natural migration after Phase 3.

### MCP inside the container
If in the future the agent needs access to Linear, Notion, or other
services via MCP: MCP servers must run inside the container or as
separate services in the compose network. The host machine's `~/.claude`
folder is not accessible from the container. Address when needed.

### Open source models (Ollama)
For full provider independence: Ollama runs locally or on the VPS
with quantized 7B models (llama3, qwen2.5-coder). Requires a VPS with
at least 8GB RAM (~15 EUR/month on Hetzner). OllamaAdapter to be added
once the rest is stable.

### Execution of LLM-generated code
The bash tool lets the agent run arbitrary commands. Acceptable for now
since you are the only user and the container is isolated.
If opened to multi-user scenarios or third-party repos, add a sandbox
(gVisor or an ephemeral network-less container).

---

## Integration with Agent Squad

### What problem it solves

Squad agents (Cody, Reven, Forge, etc.) today run interactively inside
the Claude Code CLI. They require active presence.
Hive makes them autonomous and trigger-driven.

### How it integrates

Every squad agent already has a defined system prompt
(`.md` for Claude Code, `.toml` for Codex). The migration is:

```
agents/cody.md (Claude Code format)
        ↓
Extract system_prompt
Define tool list (bash + read + write, same as today)
        ↓
agents/cody-deploy.yaml (Hive format)
```

The Python runner has no knowledge of whether an agent was written
for Claude Code or Codex. The logic lives in the system prompt;
the runner is agnostic.

### Priority agents to port

| Squad Agent | GitHub Trigger | Immediate Value |
|---|---|---|
| Cody | Label `agent:develop` | Implements issue and opens PR |
| Reven | Label `agent:review` on PR | Reviews PR without manual invocation |
| Forge | Label `agent:forge` on issue | Produces analysis YAML as a comment |
| Chisel | Label `agent:chisel` on issue | Creates Linear issues from a GitHub issue |

Suggested order: Reven first (read-only, zero risk), then Cody.

### Difference from current usage

Today with Claude Code:
```
You invoke manually → agent works → you wait → result
```

With Hive:
```
You assign label → agent works in background → notification → you review
```

Claude Code remains the tool for brainstorming, interactive Forge sessions,
and architectural work that requires dialogue. Hive handles repetitive,
autonomous execution.

---

## GH-600 Coverage

Building Hive directly covers exam topics across domains D1, D2, D3, D4, D5, D6.

### D1 — Agent Architecture and SDLC (15-20%)

What you practice:
- Designing an agent with well-defined tools (bash, read, write)
- Separation between trigger, orchestration, and execution
- Integrating agents into the SDLC via GitHub (issue → PR → review)
- Using webhooks as event-driven triggers for agents

What you learn that is missing from your backlog:
- How to structure an agent to be callable from CI/CD pipelines
- How to define responsibility boundaries between agents

---

### D2 — Tool Use and Environment Interaction (20-25%) — your main gap

What you practice:
- Implementing real tools (bash, read, write) with schema and handler
- Configuring tool permissions per agent (least privilege)
- Traceability: every tool call logged with input/output
- GitHub as an interaction environment (REST API via bash)
- Connecting and using MCP servers from the container (open question, Phase 4+)

This is the heaviest exam domain. Building Hive has you practice exactly
the scenarios the exam tests: not just using tools, but configuring them,
restricting them, and tracing their use.

---

### D3 — Memory, State, and Execution (10-15%)

What you practice:
- State management between runs (SQLite for logging and deduplication)
- Ephemeral state per run (temp directory per execution)
- Passing context from trigger to agent (webhook payload → prompt)

You already have strong experience here from the squad (second-brain, Lore).
This project reinforces it with a concrete implementation.

---

### D4 — Evaluation, Error Analysis, and Tuning (15-20%)

What you practice:
- Retry logic when the agent fails (max 3 attempts, like Ralph)
- Structured logs for post-run analysis
- Comparing output across providers (AnthropicAdapter vs OpenAI)
- System prompt tuning based on real results

---

### D5 — Multi-Agent Coordination (15-20%)

What you practice:
- Orchestrating different agents on the same trigger
- Agent dependencies (Forge before Cody, as in the squad)
- Handoff via shared artifacts (issue comment → input for next agent)

You already have strong conceptual experience from the squad. Here you
implement it in a GitHub-native context, which is exactly the exam's frame.

---

### D6 — Guardrails and Accountability (10-15%)

What you practice:
- HMAC verification on the webhook (trigger authenticity)
- Tool permission scope per agent (nothing beyond bash/read/write)
- Branch protection: agent never writes to main
- Audit trail: every run logged with timestamp, trigger, output
- Mandatory human-in-the-loop before merge

---

### Exam coverage summary

| Domain | Weight | Coverage from this project |
|---|---|---|
| D1 Architecture | 15-20% | High |
| D2 Tool use / MCP | 20-25% | High (your main gap) |
| D3 Memory / State | 10-15% | Medium (already strong from squad) |
| D4 Evaluation | 15-20% | Medium |
| D5 Multi-agent | 15-20% | High |
| D6 Guardrails | 10-15% | High |

Building Hive through Phase 3 covers exam material across all six domains,
with natural concentration on D2, which is the heaviest and your largest gap.

---

## Immediate Next Steps

1. Create `hive` repo on GitHub
2. Scaffold folder structure
3. Phase 1: FastAPI + webhook receiver + Docker Compose + ngrok
4. Test with real GitHub: label an issue, see payload logged

Phase 1 definition of done: a real label payload appears in the container
logs running locally.
