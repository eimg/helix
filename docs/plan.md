# Helix — Concrete Plan

Living document. Revised as we learn.

> Package: `@eimg/helix` · command: `helix` · **experimental, not for production.**

## Milestones

- **M1 — Core engine (shipped).** Manual + inline trigger. Hybrid orchestrator. Live event log. Presets.
- **M2 — Auto + deliverable (shipped).** Express server + Run UI; GitHub poll; PR creation; merge gate execution.
- **Beyond M2 (partial).** Manage (experimental); Phase A repo bootstrap; run history/delete; local-issues demo path. Further scale still open.
- **Tests:** 57 passing (`npm test`).

---

## M1 — Core engine ✅ SHIPPED

End-to-end orchestration of a GitHub issue (or inline terminal task) through specialist agents, with a live event log and persisted run state. Proves the in-process pi SDK approach and the hybrid orchestrator shape.

### What shipped

| Area | Files |
|---|---|
| Engine core | `src/engine/{engine,eventStream,consoleLogger,types}.ts` — `runIssue(issue, deps)` loop; typed `RunEvent` stream; console logger |
| Config | `src/config.ts` (loader/validator) + `src/config/paths.ts` (`~/.helix/` + `inheritPi` resolution) |
| Provider | `src/providers/openrouter.ts` — pi `AuthStorage`/`ModelRegistry`, hybrid secrets/models |
| Specialists | `src/agents/loader.ts` (frontmatter), `session.ts` (in-process pi sessions), `loaderBuilder.ts` (shared isolation logic) |
| Orchestrator | `src/orchestrator/{workflow,driver,gates,scripted}.ts` — workflow rails + LLM driver (JSON decisions) + deterministic gates |
| Triggers | `src/triggers/{github,inline}.ts` — `gh issue view` + inline (terminal) path |
| State | `src/state/runStore.ts` — one JSON per run under `.helix/runs/` |
| CLI | `src/cli.ts` — `helix run <n>` (GitHub) / `--title`/`--body`/`--stdin` (inline) |
| Presets | `presets/agents/{planner,dev,verifier}.md` + `presets/skills/{ts,react,express,rn,expo}/SKILL.md` |
| Fixture | `examples/ts/.helix/` — reference consumer wired to the TS preset |
| Tests | `test/{gates,m1-happy-path,inline-trigger,paths,presets}.test.ts` + fakes under `src/` |

### Key decisions made during M1 (beyond the original plan)

- **Inline trigger path** — `helix run --title/--stdin` constructs an `Issue` directly, bypassing `Trigger.fetchIssue()`. Proved orchestrator and trigger are independent; automated producers are just other `Issue` sources.
- **Portability contract** — `inheritPi` toggle (default false) gates all `~/.pi/` access. Helix is npm-installable + self-contained: env var in, runs anywhere. Local `.helix/skills/` always loaded; global pi skills/extensions gated by `inheritPi`.
- **Session isolation** — specialists + orchestrator set `noExtensions`/`noSkills`/`noContextFiles`/`noThemes`/`noPromptTemplates` when `inheritPi` is false. Built-in tools unaffected.
- **LLM orchestrator output contract** — single JSON object (`run`/`done`/`escalate`), parsed defensively; unparseable → escalate (never silently mis-route).

### M1 non-goals (at the time)

No Express/HTTP; no GitHub polling/webhook (manual `gh` only); no PR creation or merge side effects (gate *logic* only); no web UI; no subprocess isolation.

---

## M2 — Auto + deliverable ✅ SHIPPED

Turn the engine into a self-driving service: issues can arrive automatically, runs can produce reviewable PRs, the merge gate acts.

### What shipped

| Area | Files |
|---|---|
| Express host | `src/server/app.ts` — `POST /runs`, `GET /runs`, `GET /runs/:id`, `DELETE /runs/:id`, SSE events, approve/reject |
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

**Preferred integration testing** uses [local-issues](https://github.com/eimg/local-issues) → Helix `POST /runs`, not GitHub. GitHub poll/PR remain available when `gh` is configured.

### M2 non-goals (at ship time; some later filled)

Originally: no full product UI, no cost dashboards. Run console + Manage have since landed as thin consumers of the M2 API.

---

## Beyond M2 — landed (partial)

| Item | Status |
|---|---|
| **Manage** | Experimental web UI + HTTP API for authoring `.helix/agents` and `.helix/skills`. No CLI yet. [→](./manage.md) |
| **Repo context Phase A** | Deterministic bootstrap + context allowlist injected into orchestrator + first specialist wave. [→](./repo-context.md) |
| **Issue-tracker callback** | Best-effort `run.completed` POST to external tracker (POC, no auth) — used with local-issues |
| **Run history / delete** | `GET /runs`, UI sidebar, `DELETE /runs/:id` for test cleanup |

---

## Still open (scale sketch)

- **Guardrails & escalation** — structured escalation codes, budgets, workspace jail, pause/resume; design only. [→](./guardrails.md)
- **Repo context B–D** — persistent `.helix/repo-memory.md`, freshness/`helix index`, semantic index
- **Observability** — cost/token dashboards, searchable history beyond local JSON
- **More providers** — Anthropic, OpenAI, … (`Provider` interface is ready)
- **First-class webhook trigger** in Helix core (today: HTTP `POST /runs` + external local-issues)
- **Subprocess isolation** for untrusted specialists
- **Manage CLI** (`helix manage`) parity
- **Settings UI/API** — edit config/secrets without hand-editing files (related to guardrail presets)
- **pi settings** — explicit `SettingsManager.inMemory(...)` Helix defaults when `inheritPi` is false
