# Helix

Agent orchestration loop built on [pi](https://pi.dev).

Helix takes a work item and drives it through specialist agents (planner, dev, verifier, …) toward a deliverable. It is **not** an LLM and **not** a coding agent — it is the system that *orchestrates* coding agents.

Package: [`@eimg/helix`](https://github.com/eimg/helix) · command: `helix`

![Helix run console](https://i.imgur.com/D1cPcgq.png)

## Requirements

- Node.js ≥ 20
- An [OpenRouter](https://openrouter.ai) API key (see [Getting started](#getting-started))
- Optional: [`gh`](https://cli.github.com/) only if you use GitHub issue/PR paths

## Install

```bash
git clone https://github.com/eimg/helix.git
cd helix
npm install
npm run build
npm link          # exposes the `helix` command globally
```

## Getting started

### 1. Initialize a target project

```bash
cd your-project
helix init --preset typescript   # also: react, express, rn, expo
```

This creates `.helix/` with specialists, skills, and config.

### 2. Configure

```bash
cp .env.example .env
```

Set your OpenRouter API key and model in `.env`. For `config.json`, specialist models, and other options, see [Config](#config).

## Quick run

Two ways to start a run without local-issues: **CLI** (blocking, logs to terminal) or **HTTP API** (async, web UI + SSE).

### CLI

From your target project directory (after init and configuration):

```bash
# Inline task — most common for a quick try
helix run --title "Fix login" --body "Empty password returns 500"

# Body from a file or pipe
helix run --stdin --title "Refactor auth" < task.md
cat task.md | helix run --stdin

# GitHub issue (needs gh auth + triggers.github.repo in config)
helix run 42
```

The CLI runs to completion and prints events to the terminal. Run state is persisted under `.helix/runs/`.

### HTTP API

Start the server, then POST a run:

```bash
cd your-project
helix serve
# → http://127.0.0.1:8319/
```

```bash
# Start an inline run (returns immediately with run id)
curl -s -X POST http://127.0.0.1:8319/runs \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix login","body":"Empty password returns 500"}'
# → {"id":"<run-id>","status":"running"}

# Poll run state
curl -s http://127.0.0.1:8319/runs/<run-id>

# List recent runs
curl -s 'http://127.0.0.1:8319/runs?limit=20'

# Stream live events (SSE)
curl -N http://127.0.0.1:8319/runs/<run-id>/events
```

You can also submit runs from the web UI at `/`. For GitHub issues via API:

```bash
curl -s -X POST http://127.0.0.1:8319/runs \
  -H 'Content-Type: application/json' \
  -d '{"issueNumber":42,"repo":"owner/name"}'
```

See [Server & web UI](#server--web-ui) for the full endpoint list and webhook payload format.

## Companion project: [local-issues](https://github.com/eimg/local-issues)

For a fuller workflow without GitHub, pair Helix with **[local-issues](https://github.com/eimg/local-issues)** — a small local issue tracker that POSTs work items into Helix and receives completion callbacks.

| Project | Role |
|---------|------|
| **Helix** (this repo) | Orchestrates specialist agents; exposes `POST /runs` and a run console |
| **[local-issues](https://github.com/eimg/local-issues)** | Local SQLite issue tracker; fires webhooks when labeled issues appear |

```
local-issues (issue + label) ──POST──► Helix /runs ──► planner → dev → verifier
       ▲                                        │
       └──────── run.completed callback ────────┘
```

**Terminal 1 — Helix on your target repo**

```bash
cd your-project
helix serve
# → http://127.0.0.1:8319/
```

**Terminal 2 — local issue tracker**

```bash
git clone https://github.com/eimg/local-issues.git
cd local-issues
npm install
npm run dev
# → http://127.0.0.1:8320/
```

**Configure local-issues** (Settings in the UI):

| Setting | Value |
|---------|-------|
| Webhook URL | `http://127.0.0.1:8319/runs` |
| Label filter | `trigger` (default) or any label you prefer |
| Webhooks enabled | on |

**Create an issue** in local-issues with the filter label (e.g. `trigger`). The tracker POSTs to Helix; a run starts and appears in the Helix run console. When the run finishes, Helix sends a `run.completed` callback — local-issues closes the issue and adds a Helix comment.

See the [local-issues README](https://github.com/eimg/local-issues#helix-integration) for webhook payload details and API reference.

## Tips

- Prefer **inline** or **local-issues** over GitHub poll until you understand merge-gate behavior.
- **GitHub PR create/merge is off by default** (`deliverable.pr: false`). The local-issues demo does not need `gh`. Enable later with `"deliverable": { "pr": true }` plus `triggers.github.repo`.
- `mergeGate.autoMerge` only matters when PR deliverables are enabled.
- Run history **delete (×)** permanently removes `.helix/runs/<id>.json` (handy while testing).

## Server & web UI

```bash
helix serve
# → http://127.0.0.1:8319/
```

| Surface | URL | Notes |
|--------|-----|--------|
| Run console | `/` | Form, live log, run history, delete finished runs |
| Manage | `/manage` | Experimental agent/skill authoring (web/API only) |
| API | `/runs`, `/runs/:id/events`, … | JSON + SSE |

Default port **8319** (phone-keypad mnemonic for HELIX). Override with `--port` or `PORT`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/runs` | Start a run (inline or GitHub issue) |
| `GET` | `/runs` | List run summaries (`?limit=`) |
| `GET` | `/runs/:id` | Run state snapshot |
| `DELETE` | `/runs/:id` | Delete a finished run |
| `GET` | `/runs/:id/events` | SSE stream of run events |
| `POST` | `/runs/:id/approve` | Approve merge gate (when PR deliverable enabled) |
| `POST` | `/runs/:id/reject` | Reject merge gate |
| `GET` | `/health` | Health check |

### `POST /runs` (webhook receiver)

Accepts inline issues from local-issues and other producers:

```json
{
  "title": "Fix login",
  "body": "Empty password returns 500",
  "labels": ["trigger"],
  "external": {
    "trackerUrl": "http://127.0.0.1:8320",
    "issueId": 7
  }
}
```

Correlation also works via headers: `X-Issues-Issue-Id`, `X-Issues-Source`. The `external` block (or headers) enables completion callbacks to local-issues.

## Config

`helix init` creates project-local `.helix/`:

```
.helix/
  config.json       # workflow wiring, triggers, mergeGate, repoContext
  agents/*.md       # specialists
  skills/*/SKILL.md
  context/*.md      # optional curated notes (Phase A bootstrap)
  runs/             # persisted runs (gitignored)
```

Useful knobs:

- **`.env`** — essentials: `OPENROUTER_API_KEY`, `HELIX_MODEL` (default: `openrouter/xiaomi/mimo-v2.5-pro`). Loaded from project root; shell exports win. If the API key is unset, Helix falls back to `~/.pi/agent/auth.json`.
- **`config.json`** — wiring only: `workflow`, `loops`, `mergeGate`, `deliverable.pr`, `triggers`, `repoContext`, `extensions`
- **`agents/*.md`** — optional per-specialist `model:` in frontmatter (overrides the default for that agent only)
- `repoContext.enabled` (default `true`) — deterministic repo bootstrap injected into the first specialist wave
- `deliverable.pr` (default `false`) — opt into GitHub PR create/merge via `gh` after successful runs
- `mergeGate` — auto-merge thresholds (only applies when `deliverable.pr` is true)

Architecture: [`AGENTS.md`](./AGENTS.md) · milestones: [`docs/plan.md`](./docs/plan.md) · Manage: [`docs/manage.md`](./docs/manage.md) · cold-start: [`docs/repo-context.md`](./docs/repo-context.md) · guardrails/escalation: [`docs/guardrails.md`](./docs/guardrails.md)

## GitHub paths (optional)

Still supported, not the primary demo path:

```bash
helix run 42                          # gh issue view
# config triggers.github.mode: "poll" # helix serve polls labeled issues
```

Needs `gh` auth and a configured `triggers.github.repo`.

## Development

```bash
npm test
npm run typecheck
npm run dev -- run --title "Smoke test" --body "Hello"
```

## License

[MIT](./LICENSE)
