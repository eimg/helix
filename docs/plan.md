# Helix — Concrete Plan

Living document. Revise as we learn. No implementation until the active milestone's tasks are agreed.

## Milestones overview

- **M1** — Core engine, no server. Manual trigger. One specialist. Live event log. Tests. Starter presets.
- **M2** — Express + GitHub auto-trigger + trigger abstraction + PR + merge gate.
- **M3+** — Web UI, full observability, more providers/triggers, subprocess isolation.

---

## M1 — Core engine (no server) ✅ DONE

**Goal:** End-to-end orchestration of a single GitHub issue through one specialist, manually triggered, with a live event log and a passing test. Proves the in-process SDK approach and the hybrid orchestrator shape.

**Done when:**
- `helix run <issue-number>` (CLI) fetches an issue via `gh issue view` (manual trigger; same fetch code will later serve the GitHub trigger).
- The orchestrator (hybrid: config workflow + LLM driver) reads the issue and decides to invoke the configured specialist.
- The specialist runs as an isolated in-process pi session (own model via OpenRouter), receives a composed handoff prompt, returns a result.
- The orchestrator reads the result and emits a final decision (proceed / done / escalate) per the workflow + gates.
- A live event log streams to the console (one structured line per event).
- Run state is written to `.helix/runs/<run-id>.json`.
- A happy-path test drives a full run with a fake provider + stubbed specialist (no network).
- Starter presets (TS/React/Express/RN/Expo) exist under `presets/` and at least the TypeScript preset is exercised by the test.

### M1 tasks

1. **Project scaffold**
   - `package.json` (type module, TS, pi SDK + OpenRouter deps)
   - `tsconfig.json`
   - `.gitignore`
   - `src/` layout per AGENTS.md folder layout
   - `git init` + initial commit

2. **Engine core**
   - `src/engine/types.ts` — core interfaces: `Run`, `RunEvent`, `SpecialistResult`, `OrchestratorDecision`, `Provider`, `Trigger`, `SpecialistSession`.
   - `src/engine/eventStream.ts` — a simple typed emitter (sync listeners + a history buffer) that the console logger and future web UI both subscribe to.
   - `src/engine/engine.ts` — the loop: trigger → orchestrator → specialists → state. Exposes `runIssue(issue, config)` returning a `Run`. Engine takes injected `Provider` and a `SpecialistSessionFactory`.

3. **Config loader**
   - `src/config.ts` — load + validate `.helix/config.json` (provider, orchestrator workflow + merge gate, specialist list). Fail loudly on missing/invalid.

4. **Provider: OpenRouter**
   - `src/providers/openrouter.ts` — implements `Provider` using pi's model registry pointed at OpenRouter. v1: read key from env (`OPENROUTER_API_KEY`).

5. **Specialist agent layer**
   - `src/agents/loader.ts` — discover `.helix/agents/*.md`, parse frontmatter (name, description, model, tools, system prompt). Mirrors pi's `subagent` example's `agents.ts`.
   - `src/agents/session.ts` — `createSpecialistSession(definition, provider, cwd)` → wraps pi `createAgentSession()` with the specialist's model, tools, and system prompt; returns a `SpecialistSession` with a `run(task)` method that collects the final assistant text + usage.

6. **Hybrid orchestrator**
   - `src/orchestrator/workflow.ts` — load the configured workflow + loop rules + merge gate from config.
   - `src/orchestrator/driver.ts` — the LLM orchestrator session (pi session, OpenRouter model). Given the issue + workflow + available specialists, it emits structured decisions: which specialist, parallel or sequential, the handoff prompt, and on each result: proceed / loop / escalate / done. Decisions are validated against the gates (retry limits, etc.) by deterministic code before execution.
   - `src/orchestrator/gates.ts` — pure functions enforcing hard gates (max retries, forbid auto-merge without verifier, etc.). Unit-tested.

7. **Trigger: GitHub (manual fetch only in M1)**
   - `src/triggers/github.ts` — `fetchIssue(repo, number)` via `gh issue view --json`. Behind a `Trigger` interface so M2's poll trigger composes it.

8. **State persistence**
   - `src/state/runStore.ts` — append-only write of `Run` + `RunEvent[]` to `.helix/runs/<run-id>.json`. v1: one file per run.

9. **Live event log**
   - `src/engine/consoleLogger.ts` — subscribes to the event stream; prints one line per event: `[run-id] HH:MM:SS TYPE summary`. Colored, readable. This is the "what's happening now" view for M1.

10. **CLI entry**
    - `src/cli.ts` — `helix run <issue-number>`: load config, build engine with OpenRouter provider + specialist factory, fetch issue, `runIssue()`, print final result + run file path.

11. **Starter presets**
    - `presets/agents/{planner,dev,verifier}.md` — generic specialist definitions.
    - `presets/skills/*/SKILL.md` — at least one reference skill per stack (ts/react/express/rn/expo) covering the project's build/lint/test commands the verifier should run.
    - A sample consumer `.helix/` (in a `examples/` repo or a fixture dir) wired to the TypeScript preset for the test.

12. **Tests**
    - `src/providers/fake.ts` — a fake provider returning canned model responses.
    - `src/agents/stubSession.ts` — a stub specialist returning canned results.
    - `test/m1-happy-path.test.ts` — drive `runIssue()` with the fake provider + stub specialist; assert the event sequence, the orchestrator's decision, and the persisted run file.
    - `test/gates.test.ts` — unit tests for the deterministic gates.

### M1 explicit non-goals
- No Express server, no HTTP.
- No automatic GitHub polling/webhook (manual `gh` fetch only).
- No PR creation, no merge gate execution (gate *logic* may be unit-tested, but no PR/merge side effects).
- No web UI, no dashboards.
- No multi-specialist parallelism beyond what the orchestrator naturally emits (the mechanism supports it; M1 test may exercise a 2-specialist path if cheap, but it's not required to ship).

---

## M2 — Auto + deliverable (sketch)

- Express server hosting the engine API (`POST /runs`, `GET /runs/:id`, SSE `/runs/:id/events`).
- Trigger abstraction: `Trigger` interface + `GitHubPollTrigger` (interval, label filter) composing M1's `fetchIssue`. Webhook + GitHub App as a near-term follow-up.
- Deliverable: open a branch + PR via `gh`. Apply the merge gate: small + verifier-passing → auto-merge; else → draft PR + notify (log/webhook stub; web UI later).
- Human-approval stub: a pending state the server exposes for later UI to approve/reject.

## M3+ — Scale (sketch)

- Web UI: manage runs, agents, skills, triggers, approvals; live event stream consumer.
- Full observability: traces, per-specialist cost/token dashboards, searchable run history.
- More providers (Anthropic, OpenAI, …) and triggers (GitLab, Jira, interval, file).
- Subprocess isolation option for untrusted specialist agents.
- Meta agent for authoring `.helix/agents` and `.helix/skills` (CLI chat now, web UI later).
