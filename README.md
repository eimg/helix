# Helix

Agent orchestration loop built on [pi](https://pi.dev).

Helix takes a work item through implementation specialists, then independently reviews its Git-backed local PR through PR-control specialists. It is **not** an LLM and **not** a coding agent — it is the system that *orchestrates* coding agents and deterministic lifecycle policy.

Package: [`@eimg/helix`](https://github.com/eimg/helix) · command: `helix`

![Helix run console](https://i.imgur.com/D1cPcgq.png)

## Acme development testbed

Helix is one of four related projects. They remain separate products with separate responsibilities.

| Project | Role |
|---|---|
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; not currently part of the runtime loop. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Local issue and PR management surface that triggers Helix and receives callbacks. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Typical exercise: Acme Issues triggers Helix, Helix works on Acme Todo, and Primer develops the separate knowledge and retrieval side of the same fictional Acme context.

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

Two ways to start a run without acme-issues: **CLI** (blocking, logs to terminal) or **HTTP API** (async, web UI + SSE).

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

The CLI runs to completion and prints events to the terminal. Run state is persisted in `.helix/runs.db` (legacy `.helix/runs/*.json` files are imported once when the database is empty).

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

## Companion project: [acme-issues](https://github.com/eimg/acme-issues)

For a fuller workflow without GitHub, pair Helix with **[acme-issues](https://github.com/eimg/acme-issues)** — a local issue and PR management surface that POSTs work and review requests into Helix.

| Project | Role |
|---------|------|
| **Helix** (this repo) | Runs implementation and independent PR-control workflows |
| **[acme-issues](https://github.com/eimg/acme-issues)** | Stores issues and local PRs; provides the human review/merge-readiness UI |

```
Acme issue ──POST /runs──► isolated worktree/branch → planner → dev self-check
    ▲                                                   │
    │                                                   ▼
    │                                        Acme local PR (draft)
    │                                                   │
    │                         POST /pr-reviews───────────┘
    │                                                   ▼
    └──── SHA-bound decision callback ◄──── reviewer + verifier → host policy
```

**Terminal 1 — Helix on your target repo**

```bash
cd your-project
helix serve
# → http://127.0.0.1:8319/
```

**Terminal 2 — local issue tracker**

```bash
git clone https://github.com/eimg/acme-issues.git
cd acme-issues
npm install
npm run dev
# → http://127.0.0.1:8320/
```

**Configure acme-issues** (Settings in the UI):

| Setting | Value |
|---------|-------|
| Webhook URL | `http://127.0.0.1:8319/runs` |
| Label filter | `trigger` (default) or any label you prefer |
| Continuation comment command | `/helix` (default) |
| Webhooks enabled | on |

**Create an issue** in acme-issues with the filter label (e.g. `trigger`). The tracker POSTs to Helix; Helix creates an isolated feature branch/worktree, then the run starts and appears in the Helix run console. On success, Helix policy-checks and commits any remaining implementation changes before registering a draft local PR in Acme Issues. The linked issue remains in progress while the PR is reviewed.

Open **Pull requests** in Acme Issues and request review. Helix checks out the exact head SHA in a detached temporary worktree and runs the independent `reviewer` and `verifier` concurrently. Acme Issues displays the findings, executed checks, decision, diff, and review history. A changed head SHA invalidates the current readiness state. Helix never merges; after manually merging the reviewed SHA, use **Mark merged** to record the result and close the linked issue.

> The current local harness assumes repositories and PR branches are trusted. Verification commands execute locally without a VM/container boundary. Do not review untrusted third-party code while credentials are present in the Helix process environment.

### Independent PR review contract

PR review is a separate Helix workflow, not another step inside the implementation run:

- It accepts both Helix-created PRs and PRs registered by another trusted producer.
- Every review is pinned to one repository, base SHA, and head SHA. Updating the head requires a new review.
- `reviewer` evaluates intent, scope, and the diff while `verifier` runs repository checks; they execute independently and concurrently in a detached exact-head worktree.
- Structured specialist reports are combined by host policy into `ready_to_merge`, `changes_requested`, or `blocked`. Invalid or incomplete evidence fails closed.
- Review state and lifecycle events are durable in `.helix/pr-reviews.db`; findings, checks, and the decision are returned to the requesting tracker.
- `ready_to_merge` is evidence for a human decision, not permission for Helix to merge.

To request more work after completion, reopen the issue or add a comment beginning with `/helix`. acme-issues sends that external event to the completed run; Helix creates a linked child run with fresh specialist sessions and bounded context from the original issue and parent outcome. This is workflow continuation, not a manual chat prompt.

See the [acme-issues README](https://github.com/eimg/acme-issues#pull-request-review-lifecycle) for the tracker-side review lifecycle, webhook payloads, and API reference.

## Tips

- Prefer **inline** or **acme-issues** over GitHub poll until you understand merge-gate behavior.
- New projects use `planner → dev` for implementation. Independent `reviewer + verifier` definitions live under `.helix/pr-agents/` and run only in PR control.
- `deliverable.localPr` defaults to `true`, but only Acme-linked server runs get a Helix-managed worktree and create a local PR. Standalone inline runs have no tracker or Git-delivery side effect.
- **GitHub PR create/merge is off by default** (`deliverable.pr: false`). The acme-issues demo does not need `gh`. Enable later with `"deliverable": { "pr": true }` plus `triggers.github.repo`.
- `mergeGate.autoMerge` only matters when PR deliverables are enabled.
- Run history **delete (×)** permanently removes the run from `.helix/runs.db` (handy while testing).

## Server & web UI

```bash
helix serve
# → http://127.0.0.1:8319/
```

| Surface | URL | Notes |
|--------|-----|--------|
| Run console | `/` | Form, live log, cached run history, and delete |
| PR Reviews | `/reviews` | Active exact-SHA reviews, durable history, lifecycle progress, findings, and checks |
| Manage | `/manage` | Experimental agent/skill authoring and default-workflow ordering (web/API only) |
| Config | `/config` | Resolved runtime settings and provenance |
| API | `/runs`, `/runs/:id/events`, … | JSON + SSE |

Default port **8319** (phone-keypad mnemonic for HELIX). Override with `--port` or `PORT`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/runs` | Start a run (inline or GitHub issue) |
| `POST` | `/runs/:id/continuations` | Start an externally triggered child run |
| `GET` | `/runs` | List run summaries (`?limit=`) |
| `GET` | `/runs/:id` | Run state snapshot |
| `DELETE` | `/runs/:id` | Delete a finished run |
| `GET` | `/runs/:id/events` | SSE stream of run events |
| `POST` | `/runs/:id/approve` | Approve merge gate (when PR deliverable enabled) |
| `POST` | `/runs/:id/reject` | Reject merge gate |
| `POST` | `/pr-reviews` | Start an independent local PR review at one exact head SHA |
| `GET` | `/pr-reviews` | List durable PR-control reviews |
| `GET` | `/pr-reviews/:id` | Inspect one PR-control review and its evidence |
| `GET` | `/pr-reviews/:id/events` | SSE stream of durable PR-review lifecycle events |
| `GET` | `/health` | Health check |

### `POST /runs` (webhook receiver)

Accepts inline issues from acme-issues and other producers:

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

Correlation also works via headers: `X-Issues-Issue-Id`, `X-Issues-Source`. The `external` block (or headers) enables completion callbacks to acme-issues.

### `POST /runs/:id/continuations`

Accepts a terminal parent run plus an idempotent external event:

```json
{
  "instruction": "Also cover the regression case",
  "externalEventId": "comment:42",
  "trigger": "issue.comment"
}
```

The parent must be `done` or `escalated`. Helix returns the existing child for a repeated `externalEventId`, and rejects a second child while one for the same parent is still running. A continuation is a new auditable workflow run; it does not resume an opaque Pi conversation.

## Config

`helix init` creates project-local `.helix/`:

```
.helix/
  config.json       # workflow wiring, triggers, mergeGate, repoContext
  agents/*.md       # implementation specialists (default: planner, dev)
  pr-agents/*.md    # independent PR specialists (default: reviewer, verifier)
  skills/*/SKILL.md
  context/*.md      # optional curated notes (Phase A bootstrap)
  runs.db           # SQLite run state (gitignored)
  pr-reviews.db     # SQLite PR-control state (gitignored)
  runs/             # legacy JSON import source (gitignored)
```

Useful knobs:

- **`.env`** — essentials: `OPENROUTER_API_KEY`, `HELIX_MODEL` (default: `openrouter/xiaomi/mimo-v2.5-pro`). Loaded from project root; shell exports win. If the API key is unset, Helix falls back to `~/.pi/agent/auth.json`.
- **`config.json`** — wiring only: `workflow`, `maxIterations`, `mergeGate`, `deliverable`, `triggers`, `repoContext`, `extensions`
- The Manage tab can add, remove, and reorder agents in the default workflow. New runs reload saved workflow and agent definitions without restarting the server.
- **`agents/*.md`** — optional per-specialist `model:` in frontmatter (overrides the default for that agent only)
- `repoContext.enabled` (default `true`) — deterministic repo bootstrap injected once into every cold specialist session
- `deliverable.localPr` (default `true`) — create an isolated implementation branch/worktree, safely finalize its commit, and register a draft PR with the linked local tracker
- `deliverable.baseBranch` (default `main`) — base ref recorded for local PR identity and review
- `deliverable.pr` (default `false`) — opt into GitHub PR create/merge via `gh` after successful runs
- `mergeGate` — auto-merge thresholds (only applies when `deliverable.pr` is true)

Vision: [`docs/vision.md`](./docs/vision.md) · architecture: [`docs/architecture.md`](./docs/architecture.md) · milestones: [`docs/plan.md`](./docs/plan.md) · Manage: [`docs/manage.md`](./docs/manage.md) · cold-start: [`docs/repo-context.md`](./docs/repo-context.md) · guardrails/escalation: [`docs/guardrails.md`](./docs/guardrails.md)

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
