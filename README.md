# Helix

Experimental agent orchestration loop built on [pi](https://pi.dev).

Helix takes a work item and drives it through specialist agents (planner, dev, verifier, …) toward a deliverable. It is **not** an LLM and **not** a coding agent — it is the system that *orchestrates* coding agents.

> **Status:** experimental / idea & testing release. **Not intended for production.**  
> Agents can edit your repo and run shell commands. Expect cost, flaky runs, and sharp edges.  
> Package: [`@eimg/helix`](https://github.com/eimg/helix) · command: `helix`

## Requirements

- Node.js ≥ 20
- An [OpenRouter](https://openrouter.ai) API key
- Optional: [`gh`](https://cli.github.com/) only if you use GitHub issue/PR paths

## Install (from source today)

npm publish is not the focus yet. From this repo:

```bash
git clone https://github.com/eimg/helix.git
cd helix
npm install
npm run build
npm link          # exposes the `helix` command
```

Later (when published):

```bash
npm install -g @eimg/helix
```

## Quick start (inline task)

```bash
cd your-project
helix init --preset typescript
export OPENROUTER_API_KEY=sk-or-...   # or ~/.helix/secrets.json
helix run --title "Fix login" --body "Empty password returns 500"
```

## Recommended demo loop: local issues + Helix serve

Day-to-day testing here does **not** require GitHub. Use [local-issues](https://github.com/eimg/local-issues) (private for now; will be public later) as a small local issue tracker that POSTs into Helix.

**Terminal 1 — Helix on your target repo**

```bash
cd your-project
helix init --preset typescript   # once
export OPENROUTER_API_KEY=sk-or-...
helix serve
# → http://127.0.0.1:8319/
```

**Terminal 2 — local issue tracker**

```bash
git clone https://github.com/eimg/local-issues.git
cd local-issues
npm install
npm run dev serve
# → http://127.0.0.1:8320/
```

Create an issue with the `helix` label (default). local-issues webhooks Helix’s `POST /runs` and a run starts. Completion callbacks back to the tracker are a best-effort POC (no auth).

### Safer first-run tips

- Prefer **inline** / **local-issues** over GitHub poll until you understand merge-gate behavior.
- **GitHub PR create/merge is off by default** (`deliverable.pr: false`). Local-issues demos do not need `gh`. Enable later with `"deliverable": { "pr": true }` plus `triggers.github.repo`.
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

## Config

`helix init` creates project-local `.helix/`:

```
.helix/
  config.json       # provider, orchestrator, triggers, mergeGate, repoContext
  agents/*.md       # specialists
  skills/*/SKILL.md
  context/*.md      # optional curated notes (Phase A bootstrap)
  runs/             # persisted runs (gitignored)
```

Useful knobs:

- `repoContext.enabled` (default `true`) — deterministic repo bootstrap injected into the first specialist wave
- `deliverable.pr` (default `false`) — opt into GitHub PR create/merge via `gh` after successful runs
- `inheritPi` (default `false`) — do not read `~/.pi/` unless you opt in
- `mergeGate` — auto-merge thresholds (only applies when `deliverable.pr` is true)

Architecture: [`AGENTS.md`](./AGENTS.md) · milestones: [`docs/plan.md`](./docs/plan.md) · Manage: [`docs/manage.md`](./docs/manage.md) · cold-start: [`docs/repo-context.md`](./docs/repo-context.md) · guardrails/escalation: [`docs/guardrails.md`](./docs/guardrails.md)

## GitHub paths (optional)

Still supported, not the primary demo path:

```bash
helix run 42                          # gh issue view
# config triggers.github.mode: "poll" # helix serve polls labeled issues
```

Needs `gh` auth and a configured `triggers.github.repo`.

## License

[MIT](./LICENSE)
