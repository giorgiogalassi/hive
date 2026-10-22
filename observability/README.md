# Hive observability (v0)

Flow-level observability for agentic development: what the agent CLIs
export through OpenTelemetry, plus the events they do not (review
verdicts, PR outcomes, review rounds, session kind), in one Grafana.

Stack: otel-collector, Prometheus (metrics, OTLP receiver), Loki (log
events), Grafana (provisioned dashboards). Self-hosted, single user.

## Run

```bash
docker compose -f observability/docker-compose.yml up -d
open http://localhost:3000        # Grafana, anonymous admin
```

## Point Claude Code at it

Add to `~/.claude/settings.json` (`env` applies to every session):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4317",
    "OTEL_LOG_TOOL_DETAILS": "1"
  }
}
```

`OTEL_LOG_TOOL_DETAILS=1` adds tool, skill and MCP server names to
`tool_result` and `skill_activated` events; without it, attribution by
skill is not possible. Leave `OTEL_LOG_USER_PROMPTS` unset: prompt text
never reaches the stack.

## Point Codex CLI at it

In `~/.codex/config.toml`:

```toml
analytics_enabled = true

[otel]
environment = "dev"

[otel.exporter]
otlp-http = { endpoint = "http://localhost:4318/v1/logs", protocol = "binary" }

[otel.metrics_exporter]
otlp-http = { endpoint = "http://localhost:4318/v1/metrics", protocol = "binary" }
```

Codex exports token counts but no cost; cost for Codex is computed in
the dashboards from tokens and a price table (not done in v0).

## Flow events

`observability/hive-emit` sends one OTLP log record with
`service.name=hive`. agent-squad hooks call it:

```bash
hive-emit hive.verdict pr=41 verdict=APPROVE round=1 agent=reven
hive-emit hive.pr pr=41 outcome=merged hours_to_merge=5.2
hive-emit hive.session kind=squad skill=ralph
```

It never fails the caller and is silent when the stack is down.

## Dashboards

- `hive-cost`: cost and tokens per day by provider, cache hit ratio,
  sessions, cost per session last 28 days vs previous 28.
- `hive-flow`: verdicts per day, tool decisions by source, raw events.

Metric names are the Prometheus rendering of the OTLP names
(`claude_code.cost.usage` becomes `claude_code_cost_usage_USD_total`);
check the exact names in Prometheus at <http://localhost:9090> after the
first session and adjust the panels: they were written from the docs,
not against live data.

## Not in v0

- Codex cost table; trace pipeline (Codex exports traces, Claude Code does not).
- Hook duration and injected-context size: present in Claude Code
  transcripts, not found in the OTEL events. The agent-squad `/stats`
  importer keeps them until an event exists.
- Any UI beyond Grafana; any runner; any multi-user setup.
