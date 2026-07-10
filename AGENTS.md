# Helix

Agent orchestration loop system built on [pi](https://pi.dev) as the runtime.

> **Status:** Experimental. M1 + M2 shipped; Manage + Phase A repo bootstrap landed. **Not for production.**  
> Package: `@eimg/helix` · command: `helix`. See [`docs/plan.md`](./docs/plan.md).

## What Helix is

Helix takes a work item (inline task, local issue tracker webhook, or GitHub issue) and autonomously drives it through user-defined **specialist agents** (planner, dev, verifier, …). A hybrid **orchestrator** coordinates them: reading the issue, deciding which to invoke and in what order, composing each specialist's handoff context, reading results, looping or escalating as needed, and producing a reviewable deliverable (branch/PR when GitHub deliverables are wired).

Helix is **not** an LLM and **not** a coding agent. It is the *system that orchestrates* coding agents. pi is the agent runtime; Helix embeds it in-process via the pi SDK.

**Primary demo path today:** [local-issues](https://github.com/eimg/local-issues) (local tracker → `POST /runs`) + `helix serve`. GitHub/`gh` remains supported but is optional.

## Core loop

```
Trigger (local-issues | inline | GitHub) ─► Orchestrator (hybrid: config workflow + LLM)
                                              │
         ┌────────────────────────────────────┼──────────────────────┐
         ▼                                    ▼                      ▼
   Specialist A (own session, model)   Specialist B (…)        …
         └────────────────── results ─────────┴──────────────────────┘
                              │  reads results, decides: loop / proceed / escalate / done
                              ▼
                   Deliverable (optional PR) + Run state persisted
```

- **Specialists run in parallel** when the orchestrator chooses, each as an **isolated in-process pi session** with its own context window, model, and tools.
- **Specialists never communicate with each other.** The orchestrator is the *only* coordination point.
- **One process.** Parallelism = `Promise.all` over in-process `createAgentSession()` sessions. Subprocess isolation is a future option for untrusted agents, out of scope for now.

## Hybrid orchestrator

The orchestrator is neither a fixed pipeline nor a free-form LLM:

1. **Workflow in config** — declares specialists, a default sequence (e.g. planner → dev → verifier), loop rules (verifier fail → back to dev, max N retries), and merge gate thresholds.
2. **An LLM orchestrator** reasons *within* that scaffold: reads the issue, decides which specialists to actually invoke (may skip, reorder, parallelize), composes handoff prompts, decides loop-vs-escalate.
3. **Deterministic gates** enforce what the LLM must not own: iteration caps, mandatory human approval above merge thresholds, never auto-merge without a passing verifier.

The config gives rails; the LLM adapts to the task; code enforces safety.

## Architecture

| Area | Decision |
|---|---|
| Language | TypeScript (ESM, Node ≥ 20) |
| Package | `@eimg/helix` — npm-installable; binary remains `helix` |
| Agent runtime | pi SDK in-process (`createAgentSession`), not subprocesses |
| Parallel specialists | Isolated sessions; no inter-specialist communication; orchestrator-only coordination |
| Orchestrator | Hybrid: config workflow (rails) + LLM driver (adapts) + deterministic gates (safety) |
| LLM provider | Pluggable; OpenRouter only for v1 |
| Triggers | Inline (CLI/UI); HTTP `POST /runs` (used by [local-issues](https://github.com/eimg/local-issues)); GitHub `gh` + optional poll |
| Config / agents / skills | Repo-local, version-controlled under `.helix/` |
| Skills | Standard pi `SKILL.md`; `.helix/skills/` always loaded into specialist sessions |
| Specialist agents | Markdown + frontmatter (name, description, model, tools, system prompt) |
| Run state | File-based, one JSON per run under `.helix/runs/` |
| Repo context | Phase A: deterministic bootstrap + allowlisted docs injected into first specialist wave |
| Merge gate | Small + verified → auto-merge; big/risky → human approval via API/UI |
| Deliverable | Opt-in GitHub PR via `deliverable.pr` (default off); otherwise no-op after run |
| Web UI | Run console + experimental Manage; consumers of engine event stream + HTTP API |

## Folder layout

```
helix/                          # engine + shipped presets
  AGENTS.md
  docs/plan.md
  src/
    cli.ts                      # `helix` entry (init / run / serve)
    config.ts                   # .helix/config.json loader/validator
    config/paths.ts             # ~/.pi/ resolution for auth/models fallback
    context/                    # Phase A repo bootstrap
    callbacks/                  # issue-tracker completion webhook (POC)
    engine/                     # core loop, event stream, console logger, types
    orchestrator/               # workflow loader + LLM driver + gates + scripted (tests)
    providers/                  # OpenRouter (real) + Fake (tests)
    triggers/                   # GitHub (gh) + poll + inline
    agents/                     # specialist loader, session factory, loader builder, stub (tests)
    deliverable/                # git diff stats, PR create/merge
    run/                        # shared createRunContext + startRun
    server/                     # Express host + public UI
    manage/                     # experimental agent/skill authoring
    state/                      # run state persistence
  presets/                      # starter agents + skills (ts/react/express/rn/expo)
  examples/ts/.helix/           # reference consumer fixture
  test/
```

Consumer projects carry only:

```
<consumer-repo>/.helix/
  config.json                   # workflow wiring, triggers, merge gate (not secrets/models)
  agents/*.md                   # specialist definitions
  skills/*/SKILL.md             # skills (always loaded into specialist sessions)
  context/*.md                  # optional curated bootstrap notes
  extensions/                   # repo-local extensions (opt-in; see Portability)
  runs/                         # persisted run state (gitignored)
```

### Portability & secrets

Helix is npm-installable. Essentials resolve in **two steps** only — `.env` wins, then the operator's global pi install. There is no Helix-owned `~/.helix/` secrets/models home. `.helix/config.json` is **wiring only** (workflow, gates, triggers).

**Essentials (first wins):**

| Resource | 1. Project `.env` / process env | 2. `~/.pi/agent/` |
|---|---|---|
| Secrets (API keys) | `OPENROUTER_API_KEY` → runtime override | `auth.json` |
| Default model | `HELIX_MODEL` (else Helix shipped default) — used by orchestrator and specialists without `model:` | — |
| Model/provider defs | — | `models.json` (else pi built-ins) |

**Repo-local (always / config-gated):**

| Resource | Behavior |
|---|---|
| Skills | `.helix/skills/` always loaded into specialist sessions |
| Agents | `.helix/agents/` loaded by Helix (not pi) |
| Extensions | `.helix/extensions/` only if `extensions.enabled` |

Sessions are **always isolated** from global pi skills/extensions/context/themes/prompts (`noSkills`, `noContextFiles`, …). Auth/models may still come from pi; that is separate from session resource inheritance. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are unaffected.

## Config model

```jsonc
// .helix/config.json — wiring only
{
  "extensions": { "enabled": false },
  "repoContext": { "enabled": true },
  "deliverable": { "pr": false },
  "triggers": {
    "github": { "repo": "owner/name", "labelFilter": "helix", "mode": "poll", "intervalSec": 60 }
  },
  "orchestrator": {
    "workflow": ["planner", "dev", "verifier"],
    "loops": { "verifier-fail": { "backTo": "dev", "maxRetries": 2 } }
  },
  "mergeGate": {
    "autoMerge": true,
    "maxDiffLines": 300,
    "maxFiles": 10,
    "requireVerifierPass": true
  }
}
```

```bash
# .env — essentials (copy from .env.example)
OPENROUTER_API_KEY=
HELIX_MODEL=openrouter/xiaomi/mimo-v2.5-pro
```

GitHub PR create/merge runs only when `deliverable.pr` is `true` (and typically `triggers.github.repo` is set). Default is off for local-issues / inline demos.

## Testing & observability

- **Injectable by design:** the engine takes swappable `Provider`, `Orchestrator`, and `SpecialistSessionFactory`, so a full run is driven with `FakeProvider` + `ScriptedOrchestrator` + `StubSpecialistFactory` — no network.
- **Live event stream:** the engine emits structured `RunEvent`s (run_started, issue_fetched, orchestrator_decided, specialist_started/finished, gate_blocked, run_done/escalated/error). `consoleLogger` prints one line per event — the M1 "what's happening now" view and the foundation for further observability.
- **Config tab:** `GET /config` + `GET /config/snapshot` show resolved essentials provenance (env vs pi vs default) and wiring.

## Starter presets

Reference specialists + skills for common stacks, under `presets/` (double as test fixtures + copy-from templates):

| Preset | Specialists | Gate commands |
|---|---|---|
| TypeScript | planner, dev, verifier | `tsc --noEmit`, `npm test` |
| Express | planner, dev, verifier | `tsc --noEmit`, `npm test` (supertest) |
| React | planner, dev, verifier | `npm run build`, `npm run lint` |
| React Native | planner, dev, verifier | `tsc --noEmit`, `npm run lint` |
| Expo | planner, dev, verifier | `expo lint`, `tsc --noEmit` |

## Milestones

- **M1 — Core engine (shipped).** CLI, hybrid orchestrator, OpenRouter provider, in-process pi specialist sessions, GitHub + inline triggers, run state, live event log, presets.
- **M2 — Auto + deliverable (shipped).** Express server + Run UI; GitHub poll; PR creation; merge gate execution; `helix serve`.
- **Beyond M2 (partial).** Manage UI/API (experimental); Phase A repo bootstrap; run history + delete; local-issues integration path. [details](./docs/plan.md)
- **Guardrails & escalation (design).** Structured stop/pause model and safety policy — not implemented yet. [→](./docs/guardrails.md)

## Working conventions

- pi is the runtime — read the pi docs (`docs/sdk.md`, `docs/extensions.md`, `docs/skills.md`) and examples (`examples/sdk/`, `examples/extensions/subagent/`) before building anything agent-related.
- Keep the engine decoupled from Express: the server is a consumer of the engine API, never the engine itself.
- Prefer interfaces + injection over globals, so runs are testable with fakes.
- Revise `docs/plan.md` as we learn.
