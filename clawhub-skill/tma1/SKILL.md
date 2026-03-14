---
name: tma1
version: 0.2.0
description: |
  Local-first LLM agent observability.

  Use when users say:
  - "install tma1"
  - "setup observability"
  - "monitor my agent"
  - "how much am I spending on tokens"
  - "what has my agent been doing"
  - "local observability"
  - "I don't want to send data to the cloud"
  - "track token usage"
  - "agent metrics"
  - "agent telemetry"
  - "what is my agent executing"
  - "agent security audit"
  - "prompt injection risk"

keywords:
  - tma1
  - observability
  - token usage
  - cost tracking
  - agent monitoring
  - local telemetry
  - otel
metadata:
  openclaw:
    emoji: "🪨"
---

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ████████╗███╗   ███╗ █████╗  ██╗                           │
│      ██╔══╝████╗ ████║██╔══██╗ ██║                           │
│      ██║   ██╔████╔██║███████║ ██║                           │
│      ██║   ██║╚██╔╝██║██╔══██║ ██║                           │
│      ██║   ██║ ╚═╝ ██║██║  ██║ ███████╗                      │
│      ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝ ╚══════╝                      │
│                                                              │
│   your agent runs. tma1 remembers.                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

# TMA1

TMA1 gives you local-first observability for your AI agent.
Token usage, cost, latency — stored locally, queryable with plain SQL.
No cloud account. No Docker. No Grafana setup.
Works with Claude Code, Codex, OpenClaw, or any OTel-enabled agent.

The name comes from TMA-1 (Tycho Magnetic Anomaly-1) in *2001: A Space Odyssey*:
the monolith buried on the moon, silently recording everything until you dig it out.

---

## When to use this skill

Use this skill when the user wants to understand what their AI agent has been doing:

- "how much did my agent spend on tokens today?"
- "show me my agent's activity over the last week"
- "set up local observability for my agent"
- "I don't want to send telemetry to the cloud"
- "what tools is my agent calling?"
- "check for prompt injection attempts"

---

## When NOT to use this skill

- The user wants persistent memory across sessions → use mem9 instead

---

## What you get

TMA1 captures different data depending on the agent:

| Agent | Data path | What it captures |
| --- | --- | --- |
| **Claude Code** | OTel metrics + logs | Token usage, cost, active time, tool decisions, API requests, user prompts |
| **Codex** | OTel logs + traces + metrics | User prompts, LLM calls, tool executions, token usage (separate exporters for logs/traces/metrics) |
| **OpenClaw** | OTel traces + metrics | LLM calls (model, tokens, cache), messages, webhooks, sessions, queue depth |
| **Other (GenAI SDK)** | OTel traces | Token usage, cost, latency, conversations (GenAI semantic conventions) |

The dashboard auto-detects the data source and shows the right view.

All data is stored locally in `~/.tma1/data/` and never leaves your machine.

Dashboard: **http://localhost:14318**

---

## Definition of Done

This task is NOT complete until all of the following are true:

1. TMA1 binary is installed and running (`tma1-server` process)
2. Database engine is healthy at `http://localhost:14000/health`
3. The user's agent is configured to send OTel data to TMA1 (endpoint depends on agent — see Step 3)
4. Agent has been restarted (if applicable)
5. Setup is verified (either `/status` returns ok, or the user confirms data is flowing)
6. The user has been sent the handoff message

---

## Onboarding

### Step 0 — Check for existing installation

`[AGENT]` Check if TMA1 is already running:

```bash
curl -sf http://localhost:14318/health && echo "RUNNING" || echo "NOT_RUNNING"
```

- If `RUNNING`: skip to Step 3 (configure agent).
- If `NOT_RUNNING`: continue to Step 1.

---

### Step 1 — Install TMA1

`[AGENT]` Download and run the TMA1 installer:

```bash
curl -fsSL https://tma1.ai/install.sh | bash
```

This will:
1. Download the `tma1-server` binary into `~/.tma1/bin/` (the embedded database is auto-downloaded on first start)
2. Start `tma1-server` (which manages the database engine and serves the dashboard)
3. Print the dashboard URL: `http://localhost:14318`
4. Generate the default database config at `~/.tma1/config/standalone.toml` on first start

Wait ~15 seconds for the database to start, then verify:

```bash
curl -sf http://localhost:14318/health && echo "OK" || echo "FAILED"
```

If it fails, tell the user:
> TMA1 didn't start correctly. Check logs for errors: on macOS `~/Library/Logs/tma1-server.log`, on Linux `journalctl --user -u tma1-server`.

---

### Step 2 — Verify database is healthy

```bash
curl -sf http://localhost:14000/health && echo "DB OK" || echo "DB NOT READY"
```

If not healthy after 30 seconds, something is wrong with the install. Ask the user to check logs.

---

### Step 3 — Configure the agent

`[AGENT]` Configure the user's agent to send telemetry to TMA1. Choose the section that matches:

#### OpenClaw

```bash
openclaw config set diagnostics.enabled true
openclaw config set diagnostics.otel.enabled true
openclaw config set diagnostics.otel.endpoint http://localhost:14318/v1/otlp
openclaw config set diagnostics.otel.serviceName openclaw-gateway
openclaw config set diagnostics.otel.traces true
openclaw config set diagnostics.otel.metrics true
openclaw config set diagnostics.otel.logs true
openclaw gateway restart
```

#### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:14318/v1/otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp"
  }
}
```

Claude Code exports metrics and logs (not traces). The metrics/logs exporters must be explicitly enabled.

#### Codex

Add to `~/.codex/config.toml`:

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://localhost:14318/v1/logs"
protocol = "binary"

[otel.trace_exporter.otlp-http]
endpoint = "http://localhost:14318/v1/traces"
protocol = "binary"

[otel.metrics_exporter.otlp-http]
endpoint = "http://localhost:14318/v1/metrics"
protocol = "binary"
```

Codex uses separate exporters for logs, traces, and metrics. Restart Codex after config changes.

#### Any OTel SDK

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318/v1/otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
# Then run your agent as usual
```

**Important:** After configuring, restart the agent so the new OTel config takes effect.

---

### Step 4 — Restart the agent

Restart the agent so the new OTel config takes effect.

---

### Step 5 — Verify data is flowing

Wait ~1 minute after restart, then check:

```bash
curl -sf http://localhost:14318/status | python3 -m json.tool
```

Expected response:
```json
{
  "status": "ok",
  "greptimedb": "running",
  "dashboard": "http://localhost:14318"
}
```

Also check if data has arrived:

```bash
curl -s -X POST http://localhost:14318/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SHOW TABLES"}' \
  | python3 -m json.tool
```

If you see `opentelemetry_logs`, `opentelemetry_traces`, `openclaw_*`, or `claude_code_*` tables, data is flowing.

---

### Step 6 — Handoff

`[AGENT]` After successful setup, send this handoff to the user.
Translate into the user's language while keeping the structure.

```
✅ TMA1 is running.

📊 DASHBOARD
Open: http://localhost:14318

🔌 QUERY API
All SQL queries go through POST with JSON body:

  curl -s -X POST http://localhost:14318/api/query \
    -H 'Content-Type: application/json' \
    -d '{"sql": "SHOW TABLES"}'

Note: table names containing uppercase letters (e.g. "claude_code_cost_usage_USD_total")
must be quoted with double quotes in SQL.

🔍 QUICK QUERIES

-- Claude Code: today's cost by model
SELECT model, ROUND(MAX(greptime_value), 4) AS cost_usd
FROM "claude_code_cost_usage_USD_total"
WHERE greptime_timestamp >= DATE_TRUNC('day', NOW())
GROUP BY model ORDER BY cost_usd DESC;

-- Codex: recent requests
SELECT timestamp, json_get_string(log_attributes, 'model') AS model,
  json_get_int(log_attributes, 'input_token_count') AS input_tok,
  json_get_int(log_attributes, 'output_token_count') AS output_tok
FROM opentelemetry_logs WHERE scope_name LIKE 'codex_%'
  AND json_get_int(log_attributes, 'input_token_count') IS NOT NULL
ORDER BY timestamp DESC LIMIT 10;

-- OpenClaw: token usage by model
SELECT model, token_type, SUM(greptime_value) AS tokens
FROM openclaw_tokens_total WHERE ts > NOW() - INTERVAL '1 day'
GROUP BY model, token_type ORDER BY tokens DESC;

-- Any agent: list all tables
SHOW TABLES;

💾 YOUR DATA
Stored locally in: ~/.tma1/data/

Database config: ~/.tma1/config/standalone.toml
Edit this file if you want to tune database resource usage, then restart `tma1-server`.
Never sent to any cloud service.

♻️ RESTART
If TMA1 stops, run: tma1-server
Or reinstall: curl -fsSL https://tma1.ai/install.sh | bash

💡 For more queries, read: https://tma1.ai/SKILL.md
```

---

## Useful SQL queries (for agent use)

After TMA1 is set up, the agent can answer questions using these queries.

All queries go through:
```bash
curl -s -X POST http://localhost:14318/api/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "<SQL>"}'
```

**Important**: The underlying database (GreptimeDB) uses `json_get_string()`, `json_get_int()`, `json_get_float()` for JSON column access. The `->` / `->>` operators are NOT supported.

### Detect available data

```sql
SHOW TABLES
```

Check which tables exist:
- `opentelemetry_logs` → logs from Claude Code (`body = 'claude_code.*'`) or Codex (`scope_name LIKE 'codex_%'`)
- `claude_code_cost_usage_USD_total` → Claude Code metrics
- `codex_tokens_total` → Codex metrics
- `opentelemetry_traces` → traces from Codex, OpenClaw, or GenAI SDK
- `openclaw_tokens_total` → OpenClaw metrics

---

### OpenClaw Queries (traces + metrics)

**Recent LLM calls:**
```sql
SELECT timestamp,
       "span_attributes.openclaw.model" AS model,
       "span_attributes.openclaw.channel" AS channel,
       CAST("span_attributes.openclaw.tokens.input" AS BIGINT) AS input_tok,
       CAST("span_attributes.openclaw.tokens.output" AS BIGINT) AS output_tok,
       CAST("span_attributes.openclaw.tokens.cache_read" AS BIGINT) AS cache_read,
       ROUND(duration_nano / 1000000.0, 1) AS duration_ms
FROM opentelemetry_traces
WHERE span_name = 'openclaw.model.usage'
ORDER BY timestamp DESC
LIMIT 20
```

**Token usage by model (from metrics):**
```sql
SELECT model, token_type, SUM(greptime_value) AS tokens
FROM openclaw_tokens_total
WHERE ts > NOW() - INTERVAL '1 day'
GROUP BY model, token_type
ORDER BY tokens DESC
```

**Messages by channel:**
```sql
SELECT "span_attributes.openclaw.channel" AS channel,
       "span_attributes.openclaw.outcome" AS outcome,
       COUNT(*) AS messages
FROM opentelemetry_traces
WHERE span_name = 'openclaw.message.processed'
  AND timestamp > NOW() - INTERVAL '1 day'
GROUP BY channel, outcome
ORDER BY messages DESC
```

**Error spans:**
```sql
SELECT timestamp, span_name,
       "span_attributes.openclaw.channel" AS channel,
       "span_attributes.openclaw.sessionKey" AS session
FROM opentelemetry_traces
WHERE span_name IN ('openclaw.webhook.error', 'openclaw.session.stuck')
ORDER BY timestamp DESC
LIMIT 20
```

---

### Claude Code Queries (metrics + logs)

**Cost summary (latest snapshot per model):**
```sql
SELECT model,
       ROUND(MAX(greptime_value), 4) AS cost_usd
FROM "claude_code_cost_usage_USD_total"
WHERE greptime_timestamp >= DATE_TRUNC('day', NOW())
GROUP BY model
ORDER BY cost_usd DESC
```

**Token usage (latest snapshot per model per type):**
```sql
SELECT model, type,
       MAX(greptime_value) AS tokens
FROM claude_code_token_usage_tokens_total
WHERE greptime_timestamp >= DATE_TRUNC('day', NOW())
GROUP BY model, type
ORDER BY model, type
```

**Recent API requests (from logs):**
```sql
SELECT timestamp,
       json_get_string(log_attributes, 'model') AS model,
       json_get_int(log_attributes, 'input_tokens') AS input_tok,
       json_get_int(log_attributes, 'output_tokens') AS output_tok,
       json_get_float(log_attributes, 'cost_usd') AS cost_usd,
       json_get_float(log_attributes, 'duration_ms') AS duration_ms
FROM opentelemetry_logs
WHERE body = 'claude_code.api_request'
ORDER BY timestamp DESC
LIMIT 20
```

**Tool usage (from logs):**
```sql
SELECT json_get_string(log_attributes, 'tool_name') AS tool,
       COUNT(*) AS uses,
       ROUND(AVG(json_get_float(log_attributes, 'duration_ms'))) AS avg_ms
FROM opentelemetry_logs
WHERE body = 'claude_code.tool_result'
GROUP BY tool
ORDER BY uses DESC
```

---

### Codex Queries (logs + metrics)

**Recent LLM requests:**
```sql
SELECT timestamp,
       json_get_string(log_attributes, 'model') AS model,
       json_get_int(log_attributes, 'input_token_count') AS input_tok,
       json_get_int(log_attributes, 'output_token_count') AS output_tok
FROM opentelemetry_logs
WHERE scope_name LIKE 'codex_%'
  AND json_get_int(log_attributes, 'input_token_count') IS NOT NULL
  AND timestamp > NOW() - INTERVAL '1 day'
ORDER BY timestamp DESC
LIMIT 20
```

**Tool usage:**
```sql
SELECT json_get_string(log_attributes, 'tool_name') AS tool,
       COUNT(*) AS uses,
       SUM(CASE WHEN json_get_string(log_attributes, 'success') = 'true' THEN 1 ELSE 0 END) AS ok,
       ROUND(AVG(json_get_float(log_attributes, 'duration_ms'))) AS avg_ms
FROM opentelemetry_logs
WHERE scope_name LIKE 'codex_%'
  AND json_get_string(log_attributes, 'tool_name') IS NOT NULL
  AND timestamp > NOW() - INTERVAL '1 day'
GROUP BY tool
ORDER BY uses DESC
```

**Token usage (from metrics, if available):**
```sql
SELECT model, token_type, SUM(greptime_value) AS tokens
FROM codex_tokens_total
WHERE greptime_timestamp > NOW() - INTERVAL '1 day'
GROUP BY model, token_type
ORDER BY tokens DESC
```

---

### GenAI Traces Queries (other agents)

**Recent traces:**
```sql
SELECT span_name,
       "span_attributes.gen_ai.request.model" AS model,
       "span_attributes.gen_ai.usage.input_tokens" AS input_tok,
       "span_attributes.gen_ai.usage.output_tokens" AS output_tok,
       duration_nano / 1000000 AS duration_ms,
       timestamp
FROM opentelemetry_traces
WHERE "span_attributes.gen_ai.system" IS NOT NULL
ORDER BY timestamp DESC
LIMIT 20
```

**Cost by model (from raw traces, approximate pricing):**
```sql
-- NOTE: pricing rates below are approximate and may be outdated.
-- Adjust the per-token rates to match your current provider pricing.
SELECT "span_attributes.gen_ai.request.model" AS model,
       ROUND(SUM(CASE
         WHEN "span_attributes.gen_ai.request.model" LIKE '%claude-3-5-sonnet%' THEN
           CAST("span_attributes.gen_ai.usage.input_tokens" AS DOUBLE)*3/1e6 + CAST("span_attributes.gen_ai.usage.output_tokens" AS DOUBLE)*15/1e6
         WHEN "span_attributes.gen_ai.request.model" LIKE '%gpt-4o%' THEN
           CAST("span_attributes.gen_ai.usage.input_tokens" AS DOUBLE)*2.5/1e6 + CAST("span_attributes.gen_ai.usage.output_tokens" AS DOUBLE)*10/1e6
         ELSE CAST("span_attributes.gen_ai.usage.input_tokens" AS DOUBLE)*1/1e6 + CAST("span_attributes.gen_ai.usage.output_tokens" AS DOUBLE)*3/1e6
       END), 4) AS cost_usd
FROM opentelemetry_traces
WHERE "span_attributes.gen_ai.system" IS NOT NULL
  AND timestamp >= DATE_TRUNC('day', NOW())
GROUP BY model
ORDER BY cost_usd DESC
```

**Token usage by model:**
```sql
SELECT "span_attributes.gen_ai.request.model" AS model,
       SUM(CAST("span_attributes.gen_ai.usage.input_tokens" AS DOUBLE)) AS input_tok,
       SUM(CAST("span_attributes.gen_ai.usage.output_tokens" AS DOUBLE)) AS output_tok,
       COUNT(*) AS requests
FROM opentelemetry_traces
WHERE "span_attributes.gen_ai.system" IS NOT NULL
  AND timestamp >= DATE_TRUNC('day', NOW())
GROUP BY model
ORDER BY input_tok DESC
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `tma1-server` not starting | macOS: check `~/Library/Logs/tma1-server.log`; Linux: `journalctl --user -u tma1-server`; verify port 14318 is free |
| Database not healthy | Wait longer; check port 14000 is free; inspect `~/.tma1/config/standalone.toml` if it was manually reconfigured |
| No data in dashboard | Verify agent OTel config points to TMA1 (Claude Code/OpenClaw: `/v1/otlp`; Codex: separate `/v1/logs`, `/v1/traces`, `/v1/metrics`) and restart the agent |
| Port conflict on 14000 | Set `TMA1_GREPTIMEDB_HTTP_PORT=14001` and update agent endpoint config |
| Dashboard shows "GREPTIMEDB: unreachable" | Database crashed; restart with `tma1-server` |

---

## Coexistence with mem9

TMA1 and mem9 serve different purposes and work fine together:

| | mem9 | TMA1 |
| --- | --- | --- |
| **Purpose** | Persistent cross-session memory | Agent activity observability |
| **Data** | What the agent remembers | What the agent did |
| **Storage** | Cloud (or self-hosted) | Local only |
| **Query** | Memory search API | SQL |

Install both: mem9 for memory, TMA1 for observability.

---

## Update

Do not set up automatic daily self-updates for this skill.
Only update when the user or maintainer explicitly asks.

---

```
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░  silent · local · watching                                 ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```
