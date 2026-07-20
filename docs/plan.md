# Helix — Concrete Plan

Living document. Revised as we learn.

> Package: `@eimg/helix` · command: `helix` · **experimental, not for production.**

Broader product direction across knowledge, planning, implementation, PR control, release, deployment, and production learning lives in [`vision.md`](./vision.md). This plan remains the source for shipped status and concrete next work.

## Milestones

- **M1 — Core engine (shipped).** Manual + inline trigger. Hybrid orchestrator. Live event log. Presets.
- **M2 — Auto + deliverable (shipped).** Express server + Run UI; GitHub poll; PR creation; merge gate execution.
- **Beyond M2 (partial).** Manage (experimental); Phase A repo bootstrap; run history/delete; acme-issues demo path. Further scale still open.

---

## M1 — Core engine ✅ SHIPPED

End-to-end orchestration of a GitHub issue (or inline terminal task) through specialist agents, with a live event log and persisted run state. Proves the in-process pi SDK approach and the hybrid orchestrator shape.

### What shipped

| Area | Files |
|---|---|
| Engine core | `src/engine/{engine,eventStream,consoleLogger,types}.ts` — `runIssue(issue, deps)` loop; typed `RunEvent` stream; console logger |
| Config | `src/config.ts` (wiring loader) + `src/config/{env,paths,defaults}.ts` (`.env` + pi essentials) |
| Provider | `src/providers/openrouter.ts` — pi `AuthStorage`/`ModelRegistry`; env then `~/.pi/` |
| Specialists | `src/agents/loader.ts` (frontmatter), `session.ts` (in-process pi sessions), `loaderBuilder.ts` (isolated, run-scoped specialist lanes) |
| Orchestrator | `src/orchestrator/{workflow,driver,gates,scripted}.ts` — workflow rails + LLM driver (JSON decisions) + deterministic gates |
| Triggers | `src/triggers/{github,inline}.ts` — `gh issue view` + inline (terminal) path |
| State | `src/state/runStore.ts` — SQLite by default (`.helix/runs.db`), normalized incremental events/results, legacy JSON import |
| CLI | `src/cli.ts` — `helix run <n>` (GitHub) / `--title`/`--body`/`--stdin` (inline) |
| Presets | `presets/agents/{planner,dev,verifier}.md` + `presets/skills/{ts,react,express,rn,expo}/SKILL.md` |
| Fixture | `examples/ts/.helix/` — reference consumer wired to the TS preset |
| Tests | `test/{gates,m1-happy-path,inline-trigger,paths,presets}.test.ts` + fakes under `src/` |

### Key decisions made during M1 (beyond the original plan)

- **Inline trigger path** — `helix run --title/--stdin` constructs an `Issue` directly, bypassing `Trigger.fetchIssue()`. Proved orchestrator and trigger are independent; automated producers are just other `Issue` sources.
- **Two-step essentials** — API key and model come from `.env` (wins) or the operator's global pi install (`~/.pi/agent/`). No Helix-owned `~/.helix/` secrets/models home; `config.json` is wiring only.
- **Session isolation** — specialists + orchestrator always set `noExtensions`/`noSkills`/`noContextFiles`/`noThemes`/`noPromptTemplates`. Built-in tools unaffected. Auth/models may still resolve from pi.
- **LLM orchestrator output contract** — single JSON object (`run`/`done`/`escalate`), parsed defensively; unparseable → escalate (never silently mis-route).

### M1 non-goals (at the time)

No Express/HTTP; no GitHub polling/webhook (manual `gh` only); no PR creation or merge side effects (gate *logic* only); no web UI; no subprocess isolation.

---

## M2 — Auto + deliverable ✅ SHIPPED

Turn the engine into a self-driving service: issues can arrive automatically, runs can produce reviewable PRs, the merge gate acts.

### What shipped

| Area | Files |
|---|---|
| Express host | `src/server/app.ts` — start/list/get/delete runs, linked continuations, SSE events, approve/reject |
| Run bootstrap | `src/run/bootstrap.ts` — shared `createRunContext()` + async `startRun()` for CLI and server |
| GitHub poll | `src/triggers/github-poll.ts` — `GitHubPollTrigger` + injectable `IssueLister` |
| PR creation | `src/deliverable/pr.ts` — `GhPullRequestCreator` + `FakePullRequestCreator` |
| Git / diff | `src/deliverable/git.ts` — `ShellGitContext` for merge gate diff stats |
| Deliverable pipeline | `src/deliverable/pipeline.ts` — merge gate → PR → auto-merge or pending approval |
| Merge gate | `src/orchestrator/mergeGate.ts` — pure threshold evaluation |
| CLI | `helix serve [--port]` — starts server; PR deliverable only if `deliverable.pr`; honors `triggers.github.mode: "poll"` |
| Run UI | `src/server/public/{index.html,app.js,app.css}` — form, live log, history, delete |
| State | `RunStore` load/list/delete + incremental save during runs |
| Tests | `test/{server,merge-gate,github-poll}.test.ts` — HTTP + fakes, no GitHub required |

### Demo path note

**Preferred integration testing** uses [acme-issues](https://github.com/eimg/acme-issues) → Helix `POST /runs`, not GitHub. GitHub poll/PR remain available when `gh` is configured.

### M2 non-goals (at ship time; some later filled)

Originally: no full product UI, no cost dashboards. Run console + Manage have since landed as thin consumers of the M2 API.

---

## Beyond M2 — landed (partial)

| Item | Status |
|---|---|
| **Manage** | Experimental web UI + HTTP API for authoring `.helix/agents` and `.helix/skills`, plus a simple ordered default-workflow editor. No CLI yet. [→](./manage.md) |
| **Repo context Phase A** | Deterministic bootstrap + context allowlist injected into the initial orchestrator turn and every cold specialist session. [→](./repo-context.md) |
| **Within-run context reuse** | One Pi session per specialist lane per run + bounded structured handoffs (`RunKnowledgeEntry`) |
| **Web-native streaming** | Orchestrator and specialist responses share started → live buffered deltas → durable full finished output; token deltas stay ephemeral |
| **SQLite run state** | `.helix/runs.db` default with WAL; legacy `.helix/runs/*.json` imported when the database is empty |
| **Issue-tracker callback** | Best-effort `run.completed` POST to external tracker (POC, no auth) — used with acme-issues |
| **External workflow continuations** | Issue reopen/comment events create idempotent linked child runs with fresh sessions and bounded parent context |
| **Run history / delete** | `GET /runs`, UI sidebar, `DELETE /runs/:id` for test cleanup |
| **Config observability** | Config tab + `GET /config/snapshot` — resolved essentials provenance (env / pi / default) + wiring |

---

## Strategic direction (exploration → production)

Stack and ownership posture (platform independence, Pi-first runtime profiles, workflow vs conversation modes, Temporal/OTel later, and avoiding platform gravity) lives in **[`architecture.md`](./architecture.md)**.

Short version: keep Helix’s control plane independent; use **pi as the default harness for coding and general-purpose profiles**; add a persistent single-agent conversation mode instead of forcing ordinary assistant turns through specialist orchestration; and leave ports open for alternate runtimes, **Temporal-class** durability, and **OTel**/LLM-ops exporters only when measured pain justifies them.

PR lifecycle ownership is also separated: an implementation run should eventually use a run-scoped branch/worktree and deliver a new PR, then stop. An independent PR-control module will consume existing-PR events, review or fix the existing head, report evidence, and leave merge decisions to its own policy or a human. The current combined create/approve/auto-merge pipeline remains an opt-in demo implementation. [→](./architecture.md#pull-request-lifecycle-boundary)

---

## Still open (scale sketch)

- **Architecture / substrate** — ports, two tracks, DIY→third-party swap points. [→](./architecture.md)
- **Guardrails & escalation** — structured escalation codes, budgets, workspace jail, pause/resume; design only. [→](./guardrails.md)
- **Repo context B–D** — persistent `.helix/repo-memory.md`, freshness/`helix index`, semantic index
- **Observability** — cost/token dashboards and richer searchable SQLite projections (domain `RunEvent` first; OTel later per architecture.md)
- **Durability** — resume after crash / HITL park; shape `DurableRunner` before adopting Temporal
- **General-assistant mode** — persistent Pi thread sessions, profile-specific tools/resources, streamed messages; specialist orchestration remains optional
- **Run-scoped Git delivery** — isolated branch/worktree, deterministic commit and push, and one new PR for each successful change-producing implementation run
- **Independent PR-control module** — PR webhook/comment triggers, first-class PR/head-SHA state, independent reviewers/fixers/policy, and external-PR support; owns merge decisions after Helix delivers a PR
- **More providers** — Anthropic, OpenAI, … (`Provider` interface is ready); alternate agent SDKs remain evaluation fallbacks
- **First-class webhook trigger** in Helix core (today: HTTP `POST /runs` + external acme-issues)
- **Subprocess isolation** for untrusted specialists
- **Manage CLI** (`helix manage`) parity
- **Settings UI/API** — edit wiring/secrets without hand-editing files (related to guardrail presets)
- **pi settings** — explicit `SettingsManager.inMemory(...)` Helix defaults for isolated sessions
