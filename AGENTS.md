# Helix agent guide

Helix is an experimental, platform-independent agent control plane built on the Pi SDK. The shipped product takes an inline or GitHub work item through an orchestrator and isolated coding specialists. The planned general-assistant mode will use persistent single-agent Pi threads; it must not force ordinary conversation through the multi-agent workflow.

This file is an entrypoint, not the full specification. Follow the linked docs when working in an area.

## Related projects

| Project | Local path | Responsibility |
|---|---|---|
| Primer | `~/Desktop/acme/primer` | Knowledge product and fictional Acme evidence corpus; outside the Issues → Helix runtime loop. |
| Prelude | `~/Desktop/acme/prelude` | Project inception drafting and bootstrap artifact export for a future Helix empty-workspace runtime. |
| Helix | `~/Desktop/acme/helix` | Agent workflow control plane that receives work and orchestrates changes. |
| Acme Issues | `~/Desktop/acme/acme-issues` | Local issue and PR management surface that triggers Helix and receives callbacks. |
| Acme Projects | `~/Desktop/acme/acme-projects` | Feature-idea and collaboration board for existing Helix repos; can manually create non-triggering issues through Acme Issues. |
| Acme Todo | `~/Desktop/acme/acme-todo` | Disposable target application used for agent implementation and verification. |

Existing-repo runtime flow: Acme Issues → Helix → Acme Todo, followed by a Helix completion callback to Acme Issues. Primer shares the fictional Acme context but remains a separate knowledge-product effort.

Manual feature handoff: Acme Projects ready card → linked Acme Issues issue without the configured trigger label; a human adds that label in Acme Issues to start Helix. Automatic trigger and later PR/card projections remain planned. Acme Projects does not call Helix directly; see the Project-board handoff in [`docs/vision.md`](./docs/vision.md#project-board-handoff).

New-project path: Prelude drafts inception and exports `prelude.bootstrap.v1` under its local data directory. Helix will own future bootstrap execution that consumes those exports; do not add a Prelude → Helix trigger path today.

## Read first

- [`README.md`](./README.md) — user-facing behavior, setup, CLI, HTTP API, and configuration.
- [`docs/vision.md`](./docs/vision.md) — broader product direction for connected knowledge, planning, implementation, PR, release, deployment, and learning loops.
- [`docs/plan.md`](./docs/plan.md) — shipped milestones, current status, and open work.
- [`docs/architecture.md`](./docs/architecture.md) — ownership boundaries, Pi-first strategy, platform independence, and workflow versus conversation modes.
- [`docs/guardrails.md`](./docs/guardrails.md) — current safety mechanisms and the proposed policy/escalation model.
- [`docs/repo-context.md`](./docs/repo-context.md) — repository bootstrap, run-scoped session reuse, structured handoffs, and future memory work.
- [`docs/manage.md`](./docs/manage.md) — the separate experimental agent/skill authoring surface.

Read only the relevant detailed docs, but read `architecture.md` before changing runtimes, session ownership, persistence, tools, orchestration, or deployment assumptions.

## Settled direction

- **Pi-first:** Pi is the default harness for coding and general-purpose profiles. Do not introduce another agent SDK without a measured Pi limitation and regression evidence.
- **Independent core:** Helix must remain runnable locally and headlessly. Do not make a hosted control plane, React/Next.js, Google Cloud, or another vendor topology the source of truth.
- **Own the control plane, not the agent loop:** Helix owns product modes, orchestration, gates, policy, identity/channel mapping, memory strategy, durable jobs, and presentation. Pi owns provider/model execution, tool continuation, sessions, transcripts, compaction, skills, extensions, and resource loading.
- **Two product modes:** coding workflow runs are goal-oriented and may use isolated specialists; assistant conversations are long-lived Pi threads and should use specialists only when decomposition is genuinely useful.
- **Separate PR lifecycle:** local implementation workflows use `planner → dev`, register a clean committed feature branch as an Acme local PR, and stop. Independent PR control uses `.helix/pr-agents/{reviewer,verifier}.md`, exact-SHA temporary worktrees, its own SQLite state, and structured callbacks for both Helix-created and external PRs. It reports readiness; humans merge. The GitHub auto-merge pipeline remains provisional.
- **Explicit safety:** prompt instructions are not hard guardrails. Enforce consequential restrictions at engine, session/tool, deliverable, or host boundaries.

## Current runtime invariants

- Node.js 20+, TypeScript, ESM.
- The engine is independent of Express; CLI and server are consumers of the same run API.
- The orchestrator combines workflow rails, an LLM decision, and deterministic gates.
- Specialists are isolated from one another. Each named specialist lane reuses one in-memory Pi session within a run; compact `RunKnowledgeEntry` values cross lane boundaries.
- Global Pi skills, extensions, context files, prompts, and themes are not inherited. Repo-local `.helix/skills/` are loaded explicitly; `.helix/extensions/` are opt-in.
- Default run state is SQLite at `.helix/runs.db`; legacy JSON runs are import-only compatibility state.
- Full completed orchestrator and specialist responses are durable. High-volume token deltas are live-only.
- Web runs stream orchestrator and specialist output through SSE. The direct CLI intentionally remains a compact event/preview renderer unless an explicit streaming mode is added.
- GitHub PR creation and merging are opt-in through `deliverable.pr`; local and inline runs must not acquire GitHub side effects by accident.
- Implementation workflows have no privileged verification role. Agents may run deterministic self-checks, but independent `reviewer` and `verifier` authority belongs only to PR control.
- `deliverable.localPr` only acts for a run linked to an external local tracker. The server creates an isolated run worktree and named feature branch, safely commits remaining implementation changes there, registers the PR, and cleans up the temporary checkout. It never merges or pushes. Direct/manual deliverable use still requires a clean committed feature branch.
- PR-control decisions are valid only for the requested head SHA. `reviewer` and `verifier` run independently and concurrently in a detached exact-head worktree; malformed specialist reports fail closed.

## Repository map

```text
src/cli.ts                 command entrypoint: init, run, serve
src/run/bootstrap.ts       shared construction and run startup
src/engine/                core loop, contracts, events, console renderer
src/orchestrator/          LLM driver, workflow rails, deterministic gates
src/agents/                specialist definitions, Pi sessions, resource loader
src/context/               deterministic repo bootstrap and bounded handoffs
src/state/runStore.ts      SQLite store and legacy JSON compatibility
src/server/                Express API and React asset host
web/src/                   React + TanStack Query browser UI
src/manage/                separate experimental authoring workflow
src/deliverable/           diff inspection, PR creation, merge/approval path
src/pr-control/            local PR review domain, workspace, store, policy, callbacks
src/providers/             Pi model/auth integration and test fake
src/triggers/              inline and GitHub issue inputs
presets/                   starter specialists and stack skills
examples/ts/.helix/        consumer configuration fixture
test/                      Node test runner integration and unit coverage
```

The smallest important interfaces live in [`src/engine/types.ts`](./src/engine/types.ts): `Orchestrator`, `SpecialistSessionFactory`, `SpecialistSession`, `RunStore`-related domain types, and `RunEvent`. Preserve these seams unless a deliberate architecture change is being made.

## Working rules

1. Inspect the implementation and relevant tests before editing; docs describe intent but code is the shipped behavior.
2. Keep model/provider calls behind Pi-backed runtime adapters and keep business policy out of provider code.
3. Keep durable domain events small. Stream response deltas live; do not persist one database row per token.
4. Subscribe web clients before execution can emit events, and preserve late-attach snapshots when changing streaming.
5. Keep browser rendering bounded: one collapsible block per invocation, buffered text updates, and no DOM row per token.
6. Use dependency injection and fakes for tests. Normal test runs must not need network access, provider credentials, GitHub, or an LLM.
7. Treat `.env`, `.helix/runs.db*`, `.helix/pr-reviews.db*`, `dist/`, and installed dependencies as local/generated state. Never commit secrets or runtime databases.
8. Preserve unrelated user changes. Do not silently broaden a focused fix into an architecture rewrite.
9. Update `docs/plan.md` for roadmap/status changes and `docs/architecture.md` for changed ownership or substrate decisions. Keep README claims limited to shipped user behavior.

## Validation

Run the checks appropriate to the change; before committing a cross-cutting change, run all three:

```bash
npm run typecheck
npm run build
npm test
```

For server or streaming changes, also exercise the relevant HTTP/SSE path and verify the browser UI when practical. For persistence changes, cover both SQLite reconstruction and legacy import behavior. Do not hard-code the current test count in docs; it changes frequently.
