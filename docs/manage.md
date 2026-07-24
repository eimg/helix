# Manage — agent, skill & workflow authoring

**Status:** Experimental. Web UI + HTTP API shipped; **CLI not implemented**.

Manage is a separate surface from the issue orchestration loop (`helix run` / Run UI). Operators use natural language to create, edit, or delete repo-local specialists and skills under `.helix/`, then arrange agents in the default workflow with a small structured editor.

---

## What is shipped

| Surface | Status | Entry |
|---------|--------|--------|
| **Run loop** | Shipped | `helix run`, `POST /runs`, `/` |
| **Manage (web)** | Shipped (experimental) | `helix serve` → `/manage` |
| **Manage (HTTP API)** | Shipped | `POST /manage/sessions`, … |
| **Manage (CLI)** | **Not implemented** | — |

Manage never executes the implementation workflow (`planner → dev`), the separate
PR-control workflow (`reviewer + verifier`), or inception bootstrap
(`architect → scaffolder → validator`).

---

## Web UI (`/manage`)

When `helix serve` is running:

- **Run** (`/`) — submit issues, watch specialist events, view deliverable
- **Manage** (`/manage`) — ordered workflow editor plus a prompt box for agent/skill authoring; preview drafts and deletions; **Apply** / **Discard**

Capabilities today:

- Create or update `.helix/agents/*.md`
- Create or update `.helix/pr-agents/*.md` for the fixed PR-control `reviewer` and `verifier` roles
- Create or update `.helix/inception-agents/*.md` for the fixed bootstrap `architect`, `scaffolder`, and `validator` roles
- Create or update `.helix/skills/<name>/SKILL.md` and `.helix/inception-skills/<name>/SKILL.md`
- Propose deletions (skills and project PR/bootstrap agents anytime; workflow agents only with force)
- List workflow agents, PR review agents, bootstrap agents, and skills in the inventory panel (same authoring path for all three specialist families)
- Add any repo agent to the default workflow, remove it, or move it up/down
- Save the workflow directly to `.helix/config.json`; new runs reload workflow and agent files without a server restart

The workflow editor intentionally exposes only the ordered default implementation sequence. PR control has no free-form workflow today: it resolves the fixed `reviewer` and `verifier` roles and runs them concurrently. Bootstrap likewise uses fixed roles; optional order lives in `config.json` `inception.roles` (not a Manage drag-and-drop editor yet). The inventory shows whether each effective PR or bootstrap role comes from a project definition or the built-in fallback. `helix init` copies the shipped PR and bootstrap presets into `.helix/`, so newly initialized projects report those active copies as `project`; deleting a project copy exposes the corresponding `built in` fallback. Asking Manage to change a built-in PR or bootstrap role creates a project override under the matching directory. Bootstrap specialist sessions auto-load `.helix/inception-skills/` (package presets when the project pack is empty).

GitHub delivery thresholds and delivery policy remain advanced wiring in `config.json`. They do not perform verification. The implementation sequence is a rail: the orchestrator may still skip, reorder, retry, or parallelize specialists when appropriate; `maxIterations` is the hard bound on recovery attempts.

Workflow agents may run builds, tests, linting, or other self-checks, but Helix does not recognize any workflow agent as a verifier or use Run results as merge-readiness evidence. Independent verification belongs only to the fixed PR-control roles.

Workflow editing is local and needs no model credentials. Prompt-based agent/skill authoring requires `OPENROUTER_API_KEY` (or a configured provider) for live LLM calls.

---

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/manage/agents` | List workflow agents |
| `GET` | `/manage/pr-agents` | List effective PR-review agents and their source |
| `GET` | `/manage/inception-agents` | List effective bootstrap agents and their source |
| `GET` | `/manage/skills` | List run skills |
| `GET` | `/manage/inception-skills` | List bootstrap skills |
| `GET` | `/manage/workflow` | Read the ordered default workflow |
| `PUT` | `/manage/workflow` | Replace it with `{ "steps": ["planner", "dev"] }` |
| `POST` | `/manage/sessions` | `{ "prompt": "..." }` → start session |
| `GET` | `/manage/sessions/:id` | Session state, drafts, deletions |
| `GET` | `/manage/sessions/:id/events?live=1` | SSE event stream |
| `POST` | `/manage/sessions/:id/messages` | `{ "content": "..." }` follow-up |
| `POST` | `/manage/sessions/:id/apply` | `{ "force"?: true }` write/delete on disk |
| `POST` | `/manage/sessions/:id/discard` | Close without applying |

Implementation: `src/manage/` (service, author, validate, apply, delete).

---

## CLI (not implemented)

There is **no** `helix manage`, `helix chat`, or equivalent today. All manage flows require:

```bash
helix serve
# then use /manage in the browser, or call /manage/* directly
```

### Planned CLI parity (future)

Rough target when implemented:

```bash
helix manage                          # interactive REPL (mirror of /manage)
helix manage "delete the test skill"    # one-shot prompt
```

The CLI should call the same `ManageService` / API as the web UI — no second code path. Until then, script against `http://127.0.0.1:8319/manage/*` if needed.

---

## Safety model (writes & deletes)

- Meta agent **proposes** changes as JSON (`drafts`, `deletions`); it does not write or delete directly.
- Operator must click **Apply** (web) or `POST .../apply` (API).
- Paths restricted to `.helix/agents/`, `.helix/pr-agents/`, `.helix/inception-agents/`, `.helix/skills/`, and `.helix/inception-skills/`.
- Agents listed in `config.orchestrator.workflow` cannot be deleted unless `force: true`; normally remove them in the workflow editor first.
- Workflow saves require at least one unique agent and reject names without a matching repo agent definition.
- Each run captures its starting workflow/resources. Manage changes affect new runs, not runs already in progress.
- Skill deletion removes the entire `skills/<name>/` directory.

---

## Related code

| Area | Files |
|------|--------|
| Manage core | `src/manage/{service,author,prompt,validate,apply,delete,workflow}.ts` |
| Server routes | `src/server/app.ts` |
| Web UI | `web/src/ManagePage.tsx` |
| Tests | `test/manage.test.ts` |

---

## Non-goals (current)

- No visual DAG, named workflow library, or advanced gate editor
- No token streaming from the manage agent
- No CLI REPL
- No subprocess / global pi skill publishing
