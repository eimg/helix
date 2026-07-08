# Helix — Concrete Plan

Living document. Revised as we learn.

## Milestones

- **M1 — Core engine (shipped).** Manual + inline trigger. Hybrid orchestrator. Live event log. Presets. 29 tests.
- **M2 — Auto + deliverable (shipped).** Express server; GitHub poll trigger; PR creation; merge gate execution. 37 tests.
- **M3+ — Scale.** Web UI; observability; more providers/triggers; subprocess isolation; meta agent.

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
| Tests | `test/{gates,m1-happy-path,inline-trigger,paths,presets}.test.ts` + `src/{providers/fake,agents/stubSession,orchestrator/scripted}.ts` fakes |

### Key decisions made during M1 (beyond the original plan)

- **Inline trigger path** — `helix run --title/--stdin` constructs an `Issue` directly, bypassing `Trigger.fetchIssue()`. Proved orchestrator and trigger are independent; the automated M2 trigger is just another `Issue` producer.
- **Portability contract** — `inheritPi` toggle (default false) gates all `~/.pi/` access. Helix is npm-installable + self-contained: env var in, runs anywhere. Local `.helix/skills/` always loaded; global pi skills/extensions gated by `inheritPi`.
- **Session isolation** — specialists + orchestrator set `noExtensions`/`noSkills`/`noContextFiles`/`noThemes`/`noPromptTemplates` when `inheritPi` is false. Built-in tools unaffected.
- **LLM orchestrator output contract** — single JSON object (`run`/`done`/`escalate`), parsed defensively; unparseable → escalate (never silently mis-route).

### M1 non-goals (still out of scope)

No Express/HTTP; no GitHub polling/webhook (manual `gh` only); no PR creation or merge side effects (gate *logic* only); no web UI; no subprocess isolation.

---

## M2 — Auto + deliverable ✅ SHIPPED

Turn the engine into a self-driving service: issues arrive automatically, runs produce reviewable PRs, the merge gate acts.

### What shipped

| Area | Files |
|---|---|
| Express host | `src/server/app.ts` — `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events` (SSE), `POST /runs/:id/approve\|reject` |
| Run bootstrap | `src/run/bootstrap.ts` — shared `createRunContext()` + async `startRun()` for CLI and server |
| GitHub poll | `src/triggers/github-poll.ts` — `GitHubPollTrigger` + injectable `IssueLister` |
| PR creation | `src/deliverable/pr.ts` — `GhPullRequestCreator` + `FakePullRequestCreator` |
| Git / diff | `src/deliverable/git.ts` — `ShellGitContext` for merge gate diff stats |
| Deliverable pipeline | `src/deliverable/pipeline.ts` — merge gate → PR → auto-merge or pending approval |
| Merge gate | `src/orchestrator/mergeGate.ts` — pure threshold evaluation |
| CLI | `helix serve [--port]` — starts server; honors `triggers.github.mode: "poll"` |
| State | `RunStore.load()` + incremental save during runs; extended `Run` type (approval, PR, merge gate) |
| Tests | `test/{server,merge-gate,github-poll}.test.ts` — HTTP + fakes, no GitHub required |

### M2 non-goals (still out of scope)

No web UI (server API only); no cost dashboards; no auto-merge without a passing verifier (hard gate, enforced in merge gate).

---

## M3+ — Scale (sketch)

- **Web UI** — manage runs, agents, skills, triggers, approvals; live event stream consumer. Built on the M2 server API.
- **Manage (experimental, shipped narrow v1)** — separate `/manage` page + `/manage/*` API; prompt box to create/edit/delete `.helix/agents` and `.helix/skills` with preview + apply. **Web + API only — no CLI yet.** [Details →](./manage.md)
- **Repo context / cold-start** — amortize planner exploration across runs via bootstrap injection and `.helix/` artifacts. [Design note →](./repo-context.md)
- **Observability** — traces, per-specialist cost/token dashboards, searchable run history. The `RunEvent` stream is the foundation.
- **More providers** — Anthropic, OpenAI, … (the `Provider` interface is ready).
- **More triggers** — GitLab, Jira, interval, file.
- **Subprocess isolation** — option for untrusted specialist agents (the in-process factory is swappable for a subprocess factory).
- **Meta agent** — partially shipped as Manage (web + API). CLI parity (`helix manage`) not implemented. [Details →](./manage.md)
- **pi settings** — switch specialist sessions from inherited pi `settings.json` to explicit `SettingsManager.inMemory(...)` Helix defaults (compaction/retry), respecting `inheritPi`.
