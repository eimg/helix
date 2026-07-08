# Helix

Agent orchestration loop system built on [pi](https://pi.dev) as the runtime.

> **Status:** M1 shipped (core engine, CLI, hybrid orchestrator, presets). M2 next. See [`docs/plan.md`](./docs/plan.md).

## What Helix is

Helix takes a work item (a GitHub issue, or an inline task from the terminal) and autonomously drives it to a deliverable through user-defined **specialist agents** (planner, dev, verifier, …). A hybrid **orchestrator** coordinates them: reading the issue, deciding which to invoke and in what order, composing each specialist's handoff context, reading results, looping or escalating as needed, and producing a reviewable deliverable (branch/PR).

Helix is **not** an LLM and **not** a coding agent. It is the *system that orchestrates* coding agents. pi is the agent runtime; Helix embeds it in-process via the pi SDK.

## Core loop

```
Trigger (GitHub issue | inline task) ─► Orchestrator (hybrid: config workflow + LLM)
                                              │
         ┌────────────────────────────────────┼──────────────────────┐
         ▼                                    ▼                      ▼
   Specialist A (own session, model)   Specialist B (…)        …
         └────────────────── results ─────────┴──────────────────────┘
                              │  reads results, decides: loop / proceed / escalate / done
                              ▼
                   Deliverable (branch/PR) + Run state persisted
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
| Package | `@helix/cli` — npm-installable, runs anywhere with Node + an env var |
| Agent runtime | pi SDK in-process (`createAgentSession`), not subprocesses |
| Parallel specialists | Isolated sessions; no inter-specialist communication; orchestrator-only coordination |
| Orchestrator | Hybrid: config workflow (rails) + LLM driver (adapts) + deterministic gates (safety) |
| LLM provider | Pluggable; OpenRouter only for v1 |
| Triggers | Pluggable `Trigger` interface; GitHub (`gh`) + inline (terminal) today; poll/webhook in M2 |
| Config / agents / skills | Repo-local, version-controlled under `.helix/` |
| Skills | Standard pi `SKILL.md`; `.helix/skills/` always loaded into specialist sessions |
| Specialist agents | Markdown + frontmatter (name, description, model, tools, system prompt) |
| Run state | File-based, one JSON per run under `.helix/runs/` |
| Merge gate | Small + verified → auto-merge; big/risky → human approval (stub now, web UI later) |
| Web UI (future) | Layering constraint: engine emits a structured event stream + state/control API; Express + web UI are consumers |

## Folder layout

```
helix/                          # engine + shipped presets
  AGENTS.md
  docs/plan.md
  src/
    cli.ts                      # `helix run` entry
    config.ts                   # .helix/config.json loader/validator
    config/paths.ts             # ~/.helix/ + ~/.pi/ resolution (inheritPi)
    engine/                     # core loop, event stream, console logger, types
    orchestrator/               # workflow loader + LLM driver + gates + scripted (tests)
    providers/                  # OpenRouter (real) + Fake (tests)
    triggers/                   # GitHub (gh) + inline
    agents/                     # specialist loader, session factory, loader builder, stub (tests)
    state/                      # run state persistence
  presets/                      # starter agents + skills (ts/react/express/rn/expo)
  examples/ts/.helix/           # reference consumer fixture
  test/
```

Consumer projects carry only:

```
<consumer-repo>/.helix/
  config.json                   # provider, triggers, orchestrator workflow + merge gate
  agents/*.md                   # specialist definitions
  skills/*/SKILL.md             # skills (always loaded into specialist sessions)
  extensions/                   # repo-local extensions (opt-in; see Portability)
  runs/                         # persisted run state (gitignored)
```

### Portability & secrets

Helix is npm-installable and self-contained: no pre-existing pi install required, and Helix never *writes* to a fallback source.

**Resource resolution (first wins):**

| Resource | 1. Env var (portable default) | 2. `~/.helix/` | 3. `~/.pi/agent/` |
|---|---|---|---|
| Secrets (API keys) | `OPENROUTER_API_KEY` etc. → `setRuntimeApiKey` | `secrets.json` | `auth.json` — **only if `inheritPi`** |
| Model/provider defs | — | `models.json` | `models.json` — **only if `inheritPi`** |
| Skills | — | `.helix/skills/` (always) | global pi skills — only if `inheritPi` |
| Extensions | — | `.helix/extensions/` (only if `extensions.enabled`) | global pi extensions — only if `inheritPi` |

**`inheritPi` (default `false`)** is one toggle gating ALL access to the operator's global pi config. When false, Helix never reads `~/.pi/` — not for secrets, not for models, not for skills/extensions/settings. When true, pi's global dir is a read-only last-resort fallback, and pi's default skill/extension discovery is enabled.

**Repo-local extensions** (`extensions.enabled`, default `false`) are orthogonal to `inheritPi`: they govern whether `.helix/extensions/` code runs in-process, regardless of global pi inheritance.

Local `.helix/skills/` are **always loaded** into specialist sessions (via pi's `additionalSkillPaths`, honored even with `noSkills`).

Specialist and orchestrator sessions are **isolated by default** when `inheritPi` is false: `noExtensions`, `noSkills`, `noContextFiles`, `noThemes`, `noPromptTemplates` are all set. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are unaffected — they are tool factories, not extensions.

## Config model

```jsonc
// .helix/config.json
{
  "provider": { "name": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY" },
  "inheritPi": false,
  "extensions": { "enabled": false },
  "triggers": {
    "github": { "repo": "owner/name", "labelFilter": "helix", "mode": "poll", "intervalSec": 60 }
  },
  "orchestrator": {
    "model": "openrouter/anthropic/claude-sonnet-4",
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

## Testing & observability

- **Injectable by design:** the engine takes swappable `Provider`, `Orchestrator`, and `SpecialistSessionFactory`, so a full run is driven with `FakeProvider` + `ScriptedOrchestrator` + `StubSpecialistFactory` — no network. 20 tests pass.
- **Live event stream:** the engine emits structured `RunEvent`s (run_started, issue_fetched, orchestrator_decided, specialist_started/finished, gate_blocked, run_done/escalated/error). `consoleLogger` prints one line per event — the M1 "what's happening now" view and the foundation for M3 observability.

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

- **M1 — Core engine (shipped).** CLI, hybrid orchestrator, OpenRouter provider, in-process pi specialist sessions, GitHub + inline triggers, run state, live event log, presets, 20 tests. [details](./docs/plan.md)
- **M2 — Auto + deliverable (shipped).** Express server; GitHub poll trigger; PR creation; merge gate execution. `helix serve`.
- **M3+ — Scale.** Web UI; **Manage** (experimental agent/skill authoring); observability; repo context (see [`docs/repo-context.md`](./docs/repo-context.md)); more providers & triggers; subprocess isolation.

## Working conventions

- pi is the runtime — read the pi docs (`docs/sdk.md`, `docs/extensions.md`, `docs/skills.md`) and examples (`examples/sdk/`, `examples/extensions/subagent/`) before building anything agent-related.
- Keep the engine decoupled from Express: the server is a consumer of the engine API, never the engine itself.
- Prefer interfaces + injection over globals, so runs are testable with fakes.
- Revise `docs/plan.md` as we learn.
