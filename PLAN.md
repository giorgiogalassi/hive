# Hive — Development Plan

Giorgio Galassi | 2026

---

## Goal

Build Hive, a personal open source tool to deploy agents remotely
and activate them via external triggers (GitHub webhooks, issue labels, etc.).

Primary use case: add a label to a GitHub issue or PR, a remote agent picks it up,
does the work, and posts the result back. No manual intervention between trigger and result.

Interaction model: labels are entry points and orchestrator-owned audit trail.
Steering mid-flight happens via PR comments, same as with a human colleague.

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
| Deploy CLI | `hive` (minimal Python script) | Commands: deploy, list, remove, run |
| Local dev tunnel | localtunnel (current) / ngrok / Cloudflare Tunnel | Local testing without external infrastructure. Using localtunnel (`npx localtunnel --port 8000`) — no account needed. Downside: URL changes on restart, requires updating the GitHub webhook. Migrate to a stable URL in Phase 5. |
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

### Phase 4 — Agent integration, batch execution, and full interaction model

Goal: integrate Cody and Reven as deployed agents, implement `hive run` for batch
execution, and complete the comment-driven rework loop.

#### Label model

Labels are owned by the orchestrator except for the three manual entry points.
Humans never apply labels mid-flow to steer — that's what PR comments are for.

| Label | Applied by | Meaning |
|---|---|---|
| `agent:analyze` | Human (manual) | Analyze a foreign/work issue before deciding to develop |
| `agent:develop` | Human (manual) | Implement a single issue |
| `agent:review` | Orchestrator | Reven reviews the PR (auto-applied after Cody opens it) |
| `human:review` | Orchestrator | Agent failed unrecoverably, human must inspect logs |

`hive run` is the third entry point for batch execution — no label needed, it drives
the loop itself and applies `agent:develop` per issue internally.

#### Comment-driven rework

Hive watches `issue_comment` webhooks on PRs. A comment from the repo owner
re-queues Cody with the comment as additional context. Reven's review feedback
feeds back into Cody the same way. No label changes needed to request rework.

#### `hive run` — batch execution

```bash
hive run --project my-feature
```

Fetches all issues with a given label/milestone, applies the dependency order
Chisel wrote at issue-creation time, and executes Cody → Reven per issue
sequentially. Deterministic loop, no LLM orchestrator at runtime.

```bash
hive deploy agents/cody.yaml
hive list
hive remove cody
hive run --project my-feature
```

#### Agent integration

Cody and Reven system prompts live directly in their deploy YAMLs inside `hive/agents/`.
They are copied from agent-squad at migration time. Agent-squad remains the source
for interactive CLI use; Hive owns the deployed versions. Prompts may diverge over time
as autonomous and interactive use cases differ — that's expected and fine.

Suggested port order: Reven first (read-only, zero risk), then Cody.

#### Deliverables
- `hive run` command added to the CLI
- `agents/reven.yaml` with system prompt + `agent:review` trigger (PR events)
- `agents/cody.yaml` with system prompt + `agent:develop` trigger
- `issue_comment` webhook handler for comment-driven rework
- `human:review` label applied on unrecoverable agent failure
- Label rename: `agent:review` on issues → `agent:analyze`

Definition of done: assign `agent:develop` to a real issue, Cody opens a PR,
Reven posts a review, a PR comment re-queues Cody, final PR is ready for human merge.

---

### Phase 5 — VPS deploy

Goal: move off localtunnel, have a stable public URL.

```bash
hive deploy agents/cody.yaml  # same commands, now pointing at VPS
```

Deliverables:
- Deploy to Hetzner VPS via Docker Compose
- Cloudflare DNS for a stable URL
- GitHub webhook pointing to the VPS URL

No new agent features in this phase — pure infrastructure.

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

### Separation of concerns

Agent-squad owns the interactive CLI workflow: Forge, Archy, Chisel, Seed, Lore.
These are design-time tools that require dialogue and human presence. They stay local.

Hive owns autonomous execution: Cody and Reven deployed as trigger-driven agents.
These are runtime tools that run unattended.

Ralph is retired from the Hive architecture. Its two responsibilities are now split:
dependency ordering happens at Chisel time (design), execution looping happens in
`hive run` (deterministic code). No LLM orchestrator is needed at runtime.

### Migration approach

System prompts are copied from agent-squad into Hive's deploy YAMLs directly.
No reference model, no indirection. Hive owns its deployed agent definitions.
Prompts may diverge as autonomous and interactive use cases differ — expected.

```
claude/agents/cody.md
        ↓
Copy system_prompt
        ↓
hive/agents/cody.yaml  (owns it from here)
```

### Squad flow with Hive

```
Forge (local) → Archy (local) → Chisel (local, creates issues with dependency order)
        ↓
hive run --project my-feature
        ↓
Cody implements per issue → PR opened → Reven reviews → human merges
```

Claude Code remains the tool for brainstorming, Forge sessions, and architectural
work that requires dialogue. Hive handles autonomous execution.

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
- Retry logic when the agent fails (max 3 attempts, implemented in `hive run`)
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

## Immediate Next Steps (Phase 4)

Phases 1–3 are complete. `agent:develop` is verified end-to-end: label fires,
agent runs remotely, PR opens.

1. Port Reven system prompt from agent-squad → `agents/reven.yaml`, wire to PR events
2. Port Cody system prompt from agent-squad → `agents/cody.yaml`, auto-trigger Reven after PR opens
3. Add `issue_comment` webhook handler — re-queue Cody with comment as context
4. Add `human:review` label on unrecoverable failure
5. Rename `agent:review` on issues to `agent:analyze`
6. Implement `hive run --project` batch command with topological sort over issue dependencies
