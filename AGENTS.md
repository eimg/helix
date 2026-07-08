# Helix

Agent orchestration loop system built on [pi](https://pi.dev) as the runtime.

> **Status:** Planning. No implementation yet. See [`docs/plan.md`](./docs/plan.md) for the concrete milestone breakdown.

## What Helix is

Helix takes a work item (a GitHub issue to start), and autonomously drives it to a deliverable through a set of user-defined **specialist agents** (planner, dev, verifier, auditor, maintainer, …). A hybrid **orchestrator** coordinates those specialists: reading the issue, deciding which to invoke and in what order, feeding each one context, reading results, looping or escalating as needed, and producing a reviewable deliverable (branch/PR).

Helix itself is **not** an LLM and is **not** a coding agent. It is the *system that orchestrates* coding agents. pi is the agent runtime; Helix embeds it via the pi SDK.

## Core loop

```
Trigger (GitHub issue) ─► Orchestrator (hybrid: config workflow + LLM decisions)
                              │
                              ├──► Specialist agent A (own session, own model) ──┐
                              ├──► Specialist agent B (own session, own model) ──┤  results
                              └──► ...                                          │
                              ◄────────────────────────────────────────────────┘
                              │  reads results, decides next: loop / proceed / escalate / done
                              ▼
                         Deliverable (branch/PR) + Run state persisted
```

- **Specialists run in parallel** when the orchestrator chooses, each as an **isolated in-process pi session** with its own context window, model, and tools.
- **Specialists never communicate with each other.** The orchestrator is the *only* coordination point: it composes each specialist's input context from prior results, and it is the sole reader of each specialist's output.
- **One process.** No subprocesses in v1. Parallelism = `Promise.all` over in-process `createAgentSession()` sessions. (Subprocess isolation is a future option for untrusted agents, explicitly out of scope for now.)

## Confirmed architecture decisions

| Area | Decision |
|---|---|
| Language | TypeScript |
| Host | Standalone Express server; portable; deployable for any repo |
| Agent runtime | pi SDK in-process (`createAgentSession`), **not** subprocesses |
| Parallel specialists | Isolated sessions; no inter-specialist communication; orchestrator-only coordination |
| Orchestrator | **Hybrid**: a workflow is *defined* in config; an LLM orchestrator decides *when and how* to follow it per task. Deterministic code enforces hard safety gates |
| LLM provider | Pluggable; **OpenRouter only for v1** |
| Triggers | Pluggable abstraction; **GitHub only for v1** (auto target); manual `gh` fetch during dev |
| Config / agents / skills | Repo-local, version-controlled under `.helix/` |
| Skills | Standard pi `SKILL.md` (Agent Skills standard) |
| Specialist agents | Markdown + frontmatter definition (name, description, model, tools, system prompt) |
| Run state | Persisted, file-based under `.helix/runs/`, built up incrementally |
| Loop-back / merge | Hybrid gate: small + verified → auto-merge; big/risky → human approval (web UI later; stub/log for now) |
| Agent/skill authoring | Separate **meta agent**, not the run-time orchestrator. Users ask it to generate `.helix/agents` and `.helix/skills` |
| Future web UI | Baked in as a layering constraint now: core engine emits a structured event stream + exposes a state/control API; Express is one consumer. The web UI and observability are future consumers of the same API |

## Hybrid orchestrator (precise definition)

The orchestrator is *neither* a fixed pipeline *nor* a free-form LLM. It is:

1. **A workflow defined in config** — declares the available specialists, a *default* sequence (e.g. planner → dev → verifier), loop rules (verifier fail → back to dev, max N retries), and the merge gate thresholds.
2. **An LLM orchestrator** that reasons *within* that scaffold: reads the issue, decides which specialists to actually invoke (may skip, reorder, or parallelize), decides when a step is "done," composes each specialist's handoff context, and decides loop-vs-escalate.
3. **Deterministic code that enforces hard gates the LLM must not own**: retry limits, mandatory human approval above merge thresholds, never auto-merge without a passing verifier.

Rationale: pure-LLM orchestration is unreliable; strict workflows force pointless parallelism and steps. The config gives rails; the LLM adapts to the task; code enforces safety.

## Folder layout (target)

```
helix/                          # this repo — the Helix engine + shipped presets
  AGENTS.md                     # this file
  docs/plan.md                  # concrete milestone plan
  src/
    engine/                     # core loop, event stream, state/control API
    orchestrator/               # hybrid orchestrator (workflow loader + LLM driver + gates)
    providers/                  # LLM providers (OpenRouter v1)
    triggers/                   # trigger abstraction (GitHub v1)
    agents/                     # specialist session factory, definition loader
    state/                      # run state persistence
    server/                     # Express host (one consumer of the engine API)
  presets/
    agents/                     # starter specialist definitions (ts, react, express, rn, expo)
    skills/                     # starter skills
  package.json
  tsconfig.json
```

Consumer projects (any repo that uses Helix) carry only:

```
<consumer-repo>/.helix/
  config.json                   # provider, triggers, orchestrator workflow + merge gate
  agents/*.md                   # specialist definitions
  skills/*/SKILL.md             # skills (always loaded into specialist sessions)
  extensions/                   # repo-local extensions (opt-in; see Portability)
  runs/                         # persisted run state
```

### Portability & secrets

Helix is an npm-installable package (`@helix/cli`) that runs anywhere with Node + an env var. No pre-existing pi install is required, and Helix never *writes* to a fallback source.

**Resource resolution (first wins):**

| Resource | 1. Env var (portable default) | 2. `~/.helix/` | 3. `~/.pi/agent/` |
|---|---|---|---|
| Secrets (API keys) | `OPENROUTER_API_KEY` etc. → `setRuntimeApiKey` | `secrets.json` | `auth.json` — **only if `inheritPi`** |
| Model/provider defs | — | `models.json` | `models.json` — **only if `inheritPi`** |
| Skills | — | `.helix/skills/` (always) | global pi skills — only if `inheritPi` |
| Extensions | — | `.helix/extensions/` (only if `extensions.enabled`) | global pi extensions — only if `inheritPi` |

**`inheritPi` (default `false`)** is one toggle gating ALL access to the operator's global pi config. When false, Helix is fully self-contained: it never reads `~/.pi/` at all — not for secrets, not for models, not for skills/extensions/settings. When true, pi's global dir is a read-only last-resort fallback, and pi's default skill/extension discovery is enabled. This resolves the "which config am I using?" ambiguity with a hard line.

**Repo-local extensions** (`extensions.enabled`, default `false`) are orthogonal to `inheritPi`: they govern whether `.helix/extensions/` code runs in-process, regardless of global pi inheritance. Both default off; each can be turned on independently.

Local `.helix/skills/` are **always loaded** into specialist sessions (via pi's `additionalSkillPaths`, which pi honors even with `noSkills`), because project-specific skills are the point of the project.

Specialist and orchestrator sessions are **isolated by default**: `noExtensions`, `noSkills`, `noContextFiles`, `noThemes`, `noPromptTemplates` are all set when `inheritPi` is false. Built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are unaffected — they are tool factories, not extensions.

## Config model (sketch — not final)

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
    "loops": { "verifier-fail": { "backTo": "dev", "maxRetries": 2 } },
    "parallelism": "orchestrator-decides"
  },
  "mergeGate": {
    "autoMerge": true,
    "maxDiffLines": 300,
    "maxFiles": 10,
    "requireVerifierPass": true,
    "else": "draft-pr-and-notify"
  }
}
```

## Testing & observability (v1 bar)

- **Easy to test:** the engine is pure-ish and injectable — providers, triggers, and agent sessions are all swappable behind interfaces, so a run can be driven with a fake provider and a stubbed specialist without touching the network. M1 includes a happy-path test using a fake provider.
- **"What's happening now":** the engine emits a live structured event stream (run started, orchestrator decided X, specialist A started/finished, result Y, loop/escalate, done). M1 surfaces this as a plain console/log tail (one line per event with run id + timestamp + type + summary). Full observability (dashboards, traces, cost) is M3+, but the event stream is the foundation.

## Starter presets (ship with Helix, for testing + reference)

Reference specialist agents and skills for common stacks, under `presets/`:

| Preset | Specialist(s) | Notes |
|---|---|---|
| TypeScript | planner, dev, verifier | generic TS project; typecheck + test gates |
| Express | planner, dev, verifier | API routes; supertest-based verification |
| React | planner, dev, verifier | web; build + lint gates |
| React Native | planner, dev, verifier | native; build gate |
| Expo | planner, dev, verifier | Expo Router; `expo lint` / build gates |

These double as the test fixtures for M1 and as templates users (or the meta agent) copy from.

## Milestones (summary — see docs/plan.md for the concrete breakdown)

- **M1 — Core engine, no server.** OpenRouter provider; one specialist loaded from `.helix/agents/`; hybrid orchestrator reads a single issue (manual `gh` fetch) and dispatches to that specialist via in-process SDK session; prints result + live event log; run state to `.helix/runs/`. Starter presets included. Tests with a fake provider.
- **M2 — Auto + deliverable.** Express server; GitHub trigger (poll) + trigger abstraction; PR open; merge gate (auto for small, human-approval stub for big).
- **M3+ — Scale.** Web UI; full observability; more providers & triggers; subprocess-isolation option for untrusted agents.

## Working conventions

- No implementation begins until the current milestone's tasks in `docs/plan.md` are agreed. We revise the plan doc as we learn.
- pi is the runtime — read the pi docs (`docs/sdk.md`, `docs/extensions.md`, `docs/skills.md`) and examples (`examples/sdk/`, `examples/extensions/subagent/`) before building anything agent-related.
- Keep the engine decoupled from Express: the server is a consumer of the engine API, never the engine itself.
- Prefer interfaces + injection over globals, so runs are testable with fakes.
