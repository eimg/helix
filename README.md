# Helix

Agent orchestration loop built on [pi](https://pi.dev).

Helix takes a work item through implementation specialists, then independently reviews its Git-backed local PR through PR-control specialists. It is **not** an LLM and **not** a coding agent — it is the system that *orchestrates* coding agents and deterministic lifecycle policy.

Package: [`@eimg/helix`](https://github.com/eimg/helix) · command: `helix`

![Helix run console](https://i.imgur.com/D1cPcgq.png)

## Acme development testbed

The Acme suite is an executable reference architecture, not an all-inclusive platform or a universal prescription. Its local-first, independently runnable products and replaceable integration seams let subject-matter experts inspect working patterns and adapt the parts that fit their organization.

Helix is one of the related projects. They remain separate products with separate responsibilities.

| Project | Role |
|---|---|
| **[Primer](https://github.com/eimg/primer)** | Knowledge product and fictional Acme evidence corpus; not currently part of the Issues → Helix runtime loop. |
| **[Prelude](https://github.com/eimg/prelude)** | Project inception workspace; drafts freeform docs and exports bootstrap artifacts for Helix empty-workspace bootstrap. |
| **[Helix](https://github.com/eimg/helix)** | Agent workflow control plane that receives work and orchestrates changes. |
| **[Acme Issues](https://github.com/eimg/acme-issues)** | Local issue and PR management surface that triggers Helix and receives callbacks. |
| **[Acme Projects](https://github.com/eimg/acme-projects)** | Feature-idea and collaboration board for existing Helix repos; can manually create non-triggering issues through Acme Issues. |
| **[Acme Steering](https://github.com/eimg/acme-steering)** | Optional decision inbox and delegation policy; receives Helix lifecycle events and may invoke only narrow run recovery. |
| **[Acme Todo](https://github.com/eimg/acme-todo)** | Disposable target application used for agent implementation and verification. |

Existing-repo exercise: Acme Issues triggers Helix, Helix works on Acme Todo, and Helix callbacks update Acme Issues. Acme Projects can create a thin linked issue without triggering Helix; a human normally adds the configured trigger label to start that flow. Optional Steering may request submission and triggering through the owning products' separate actions, and Issues projects accepted-run, PR, and completion state back to Projects. Acme Projects will not call Helix directly; see [`docs/vision.md`](./docs/vision.md#project-board-handoff).

New-project path: Prelude owns inception drafting and exports `prelude.bootstrap.v1` artifacts. Helix owns empty-workspace bootstrap (`helix bootstrap --export …` dry-run/execute, or `helix serve` then Bootstrap UI): creates git + `.helix` in place with fixed `architect` / `scaffolder` / `validator` specialists; inception skills auto-load into bootstrap sessions. Specialist LLM execution after materialize is next. Prelude does not call Helix. Primer may supply evidence to Prelude over HTTP and remains outside the Issues → Helix loop.

## Requirements

- Node.js ≥ 22.19 (the pi SDK requires it; Node 24 LTS also works)
- An [OpenRouter](https://openrouter.ai) API key (see [Getting started](#getting-started))
- Optional: [`gh`](https://cli.github.com/) only if you use GitHub issue/PR paths

## Install

```bash
git clone https://github.com/eimg/helix.git
cd helix
npm install
npm run build
npm link          # exposes `helix` (built) and `helix-dev` (source) globally
```

`helix` runs the last build in `dist`. `helix-dev` runs the same CLI straight from
`src`, so changes to this checkout apply to other projects without rebuilding.
Run either command from the target repository: Helix intentionally uses the
current working directory as its workspace. `npm run dev` in the Helix source
checkout is for developing Helix itself; it does not start Helix for another
target application.

## Getting started

### 1. Initialize a target project

```bash
cd your-project
helix init --preset typescript   # also: react, express, rn, expo
```

This creates `.helix/` with specialists, skills, and config.

### 2. Configure

```bash
cp .helix/.env.example .helix/.env
```

Set your OpenRouter API key and model in `.helix/.env`. Keep app/runtime secrets in the repo-root `.env` (not Helix’s file). For `config.json`, specialist models, and other options, see [Config](#config).

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

### HTTP authentication

Helix is standalone by default: `HELIX_AUTH_PROVIDER=standalone` grants the local
HTTP operator full access and does not contact another service. This affects only
the Express host; CLI runs and the orchestration engine do not depend on auth.

To use a replaceable HTTP identity provider, set:

```bash
HELIX_AUTH_PROVIDER=acme-identity
HELIX_AUTH_URL=http://127.0.0.1:8316
```

The bundled adapter translates the provider principal into a Helix-owned shape.
Human sessions use the web sign-in screen and same-origin cookie proxy. API callers
send `Authorization: Bearer <token>`. Provider errors fail closed with `503`.
The operator menu shows whether the host is standalone or Identity-backed. An
external adapter may optionally supply an account-management URL; Helix does
not hardcode or import the provider UI.

Helix authorizes capabilities, not role names: `helix.read`, `helix.trigger`,
`helix.review`, `helix.merge`, `helix.bootstrap`, `helix.manage`, and `helix.admin`.
Namespace grants such as `helix.*` and the suite wildcard `*` are supported, so
future roles do not require Helix changes.

Optional outbound service credentials remain ordinary HTTP configuration:

- `HELIX_PRELUDE_TOKEN` authenticates export catalog and package reads.
- `HELIX_ISSUES_TOKEN` authenticates issue/PR registration and callbacks.

Each credential is origin-bound. `HELIX_TRUSTED_PRELUDE_ORIGINS` defaults to
`http://127.0.0.1:8318`; `HELIX_TRUSTED_ISSUES_ORIGINS` defaults to
`http://127.0.0.1:8320`. Helix rejects a credentialed request whose operator- or
payload-supplied URL points elsewhere. Comma-separated alternatives support a
replacement service without coupling Helix to its implementation.

Unset tokens keep standalone and unauthenticated integrations usable.
If Prelude is Identity-backed, however, its catalog correctly returns `401`
without `HELIX_PRELUDE_TOKEN`. A standalone Helix operator and an
Identity-backed Prelude are valid but constitute a mixed-mode setup; either run
Prelude standalone for feature testing or provision the scoped machine token.

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

**Configure acme-issues** (per-project Settings in the UI):

| Setting | Value |
|---------|-------|
| Webhook URL | `http://127.0.0.1:8319/runs` |
| Label filter | `trigger` (default) or any label you prefer |
| Continuation comment command | `/helix` (default) |
| Callback / base URL | Issues public URL Helix should call back (e.g. `http://127.0.0.1:8320`) |
| Webhooks enabled | on |

**Create an issue** in acme-issues with the filter label (e.g. `trigger`). The tracker POSTs to Helix; Helix creates an isolated feature branch/worktree, then the run starts and appears in the Helix run console. On success, Helix policy-checks and commits any remaining implementation changes before registering a draft local PR in Acme Issues. The linked issue remains in progress while the PR is reviewed.

Open **Pull requests** in Acme Issues and request review. Helix checks out the exact head SHA in a detached temporary worktree and runs the independent `reviewer` and `verifier` concurrently. Acme Issues displays the findings, executed checks, decision, diff, and review history. A changed head SHA invalidates the current readiness state. Helix never auto-merges; after review passes, use **Merge** in Acme Issues (which prefers Helix `POST /local-prs/merge`) to record the result and close the linked issue.

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

Live server runs can also be paused and resumed without creating a child. Helix finishes the current safe orchestration boundary, persists the next orchestrator decision or remaining specialist invocations, and releases the live session objects. Pi lane transcripts are stored under `.helix/sessions/<run-id>/`. Deliverable finalization is a separate checkpoint, so a restart after implementation does not rerun the agents. On server startup, stale execution becomes `interrupted`; an invocation or delivery attempt that was active becomes `uncertain` and requires an explicit operator-confirmed retry. `SIGINT`/`SIGTERM` first ask active runs to pause and wait up to ten seconds for safe boundaries. This is intentionally visible demo-grade recovery, not exactly-once execution or a production workflow engine.

See the [acme-issues README](https://github.com/eimg/acme-issues#pull-request-review-lifecycle) for the tracker-side review lifecycle, webhook payloads, and API reference.

## Tips

- Prefer **inline** or **acme-issues** over GitHub poll until you understand merge-gate behavior.
- New projects use `planner → dev` for implementation. Independent `reviewer + verifier` definitions live under `.helix/pr-agents/` and run only in PR control.
- Workflow agents can run builds, tests, and other self-checks, but no Run agent has special verification authority. Independent verification is always a PR-control responsibility.
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
| Run console | `/` | Form, live log, cached run history, pause/resume, and delete |
| PR Reviews | `/reviews` | Active exact-SHA reviews, durable history, lifecycle progress, findings, and checks; nav disabled until git exists |
| Bootstrap | `/bootstrap` | Empty-workspace execute, or read-only receipt when the repo has Helix bootstrap artifacts; nav disabled on plain existing git |
| Manage | `/manage` | Experimental authoring for run, PR, and bootstrap agents/skills plus default-workflow ordering (web/API only) |
| Config | `/config` | Resolved runtime settings including workflow, PR control, and bootstrap resources/provenance |
| API | `/runs`, `/runs/:id/events`, … | JSON + SSE |

Default port **8319** (phone-keypad mnemonic for HELIX). Override with `--port` or `PORT`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/runs` | Start a run (inline or GitHub issue) |
| `POST` | `/runs/:id/continuations` | Start an externally triggered child run |
| `POST` | `/runs/:id/pause` | Request a live run to park at its next safe boundary |
| `POST` | `/runs/:id/resume` | Resume the same run; uncertain work requires `{ "retryUncertain": true }` |
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
| `POST` | `/local-prs/merge` | Human-initiated local Git merge for a reviewed head (used by Acme Issues) |
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

Correlation also works via headers: `X-Issues-Issue-Id`, `X-Issues-Source`.
The `external` block (or headers) enables completion callbacks and local PR
registration against Helix’s flat tracker contract
(`POST/PATCH {trackerUrl}/api/pull-requests`, `POST …/api/webhooks/helix`).
Trackers may send extra fields; Helix ignores them.

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

### `POST /runs/:id/pause` and `/resume`

`pause` accepts only a live execution run. It changes the run to `pause_requested`, lets the active orchestrator call or specialist batch reach a checkpoint, then persists `paused`. `resume` accepts `paused` or `interrupted`, keeps the same run ID and retained implementation worktree, reopens the run-scoped Pi lane sessions, and continues from the stored checkpoint. If Helix stopped after a specialist or deliverable attempt started but before it was durably completed, a normal resume returns `409` with `requiresRetryConfirmation: true`; the UI asks for confirmation, or an API caller may retry deliberately with `{ "retryUncertain": true }`. Both actions require `helix.trigger`.

## Config

`helix init` creates project-local `.helix/`:

```
.helix/
  config.json              # workflow wiring, inception roles, triggers, mergeGate, repoContext
  agents/*.md              # implementation specialists (default: planner, dev)
  pr-agents/*.md           # independent PR specialists (default: reviewer, verifier)
  inception-agents/*.md    # empty-workspace specialists (architect, scaffolder, validator)
  skills/*/SKILL.md
  inception-skills/*/SKILL.md
  context/*.md             # optional curated notes (Phase A bootstrap)
  runs.db                  # SQLite run state (gitignored)
  sessions/<run-id>/       # resumable Pi specialist lane transcripts (gitignored)
  pr-reviews.db            # SQLite PR-control state (gitignored)
  runs/                    # legacy JSON import source (gitignored)
```

The `reviewer` / `verifier` and inception `architect` / `scaffolder` / `validator` files are copied from Helix’s shipped presets during initialization. Config and Manage therefore report them as `project` definitions once copied. If a project-local definition is absent, Helix resolves the corresponding shipped `built in` fallback instead. Bootstrap sessions auto-load `.helix/inception-skills/` (package presets when the project pack is empty); run/PR sessions load `.helix/skills/`.

Inception bootstrap (empty-workspace entry — no prior git required; target
defaults to the current folder; `--execute` creates git + `.helix` in place):

```bash
mkdir my-app && cd my-app
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --dry-run
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --execute
# or: helix serve   # scaffolds .helix; then bootstrap --execute for git
```

See [`docs/inception-bootstrap.md`](./docs/inception-bootstrap.md).

Useful knobs:

- **`.helix/.env`** — Helix essentials: `OPENROUTER_API_KEY`, `HELIX_MODEL` (default: `openrouter/xiaomi/mimo-v2.5-pro`). Loaded from `.helix/`; shell exports win. If the API key is unset, Helix falls back to `~/.pi/agent/auth.json` (override that directory with `PI_AGENT_DIR`). Repo-root `.env` is for the application (and is only used as a migration fallback when `.helix/.env` is missing).
- **`config.json`** — wiring only: `workflow`, `inception.roles`, `maxIterations`, `mergeGate`, `deliverable`, `triggers`, `repoContext`, `extensions`
- The Manage tab can author workflow agents, PR-review agents, bootstrap agents, and both skill packs. It can also add, remove, and reorder agents in the default implementation workflow; PR control remains the fixed concurrent `reviewer + verifier` pair; bootstrap uses the fixed role set with optional `inception.roles` order. New runs and reviews reload saved definitions without restarting the server.
- **`agents/*.md`** — optional per-specialist `model:` in frontmatter (overrides the default for that agent only)
- `repoContext.enabled` (default `true`) — deterministic repo bootstrap injected once into every cold specialist session
- `deliverable.localPr` (default `true`) — create an isolated implementation branch/worktree, safely finalize its commit, and register a draft PR with the linked local tracker
- `deliverable.baseBranch` (default `main`) — base ref recorded for local PR identity and review
- `deliverable.pr` (default `false`) — opt into GitHub PR create/merge via `gh` after successful runs
- `mergeGate` — size-based GitHub delivery thresholds (only applies when `deliverable.pr` is true; it does not perform verification)

Vision: [`docs/vision.md`](./docs/vision.md) · architecture: [`docs/architecture.md`](./docs/architecture.md) · milestones: [`docs/plan.md`](./docs/plan.md) · Manage: [`docs/manage.md`](./docs/manage.md) · inception: [`docs/inception-bootstrap.md`](./docs/inception-bootstrap.md) · cold-start: [`docs/repo-context.md`](./docs/repo-context.md) · guardrails/escalation: [`docs/guardrails.md`](./docs/guardrails.md)

## GitHub paths (optional)

Still supported, not the primary demo path:

```bash
helix run 42                          # gh issue view
# config triggers.github.mode: "poll" # helix serve polls labeled issues
```

Needs `gh` auth and a configured `triggers.github.repo`.

## Optional Steering notifications

Set `ACME_STEERING_URL` in the target repository's `.helix/.env` to publish durable run lifecycle events to Acme Steering, or configure the same non-secret URL under **Connections** in the Helix UI. A saved Connections value overrides the startup environment; clearing it returns to startup configuration or disables notifications. In shared local-auth mode, set a scoped `ACME_STEERING_TOKEN` with `steering.notify.helix`. Output deltas and tool activity are intentionally excluded; lifecycle, gate, interruption, escalation, and completion events are best-effort and never block a run. Manual Helix recovery remains available and its next event reconciles Steering.

The shipped reference policy keeps Helix recovery human-required. Only the accepted, reversible Prelude export is policy-automated; a later organization-specific policy must not broaden Helix recovery beyond this explicit action and Helix's own live-state checks.

Helix accepts `helix.recover_run` at `POST /api/steering/actions`. The caller needs the action-specific `helix.steering.recover` permission; Helix reloads the run, checks the last durable event revision, and resumes only a paused or interrupted run. Approval explicitly confirms uncertain retries. Merge, bootstrap, deletion, and arbitrary run mutation are not exposed.

Every Steering disposition is independently accepted at `POST /api/steering/decisions` with `helix.steering.receive`, recorded in the run's durable metadata, and shown beside the persisted run outcome/checkpoint. Receipt does not append a run event, alter its revision, or resume execution. A non-approval disposition holds an already paused/interrupted run; an approval is shown as awaiting recovery until the separate narrow recovery action is accepted. Active runs, completed runs, and stale decisions are observation-only. Helix still owns any richer response to revision, cancellation, or escalation.

## Development

```bash
npm run verify                                  # typecheck + test + build
npm run dev                                     # develop Helix against this source checkout
cd /path/to/target && helix-dev serve            # source Helix against a target repo
cd /path/to/target && helix-dev run --title "Smoke test" --body "Hello"
```

`npm run dev` and `helix-dev` serve the web UI from `web/` through Vite, so `dist`
only matters for `npm start`, `npm link`, and publishing.

## License

[MIT](./LICENSE)
