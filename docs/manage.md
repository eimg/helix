# Manage — agent & skill authoring

**Status:** Experimental. Web UI + HTTP API shipped on `feat/manage-ui`; **CLI not implemented**.

Manage is a separate surface from the issue orchestration loop (`helix run` / Run UI). Operators use natural language to create, edit, or delete repo-local specialists and skills under `.helix/`.

---

## What is shipped

| Surface | Status | Entry |
|---------|--------|--------|
| **Run loop** | Shipped | `helix run`, `POST /runs`, `/` |
| **Manage (web)** | Shipped (experimental) | `helix serve` → `/manage` |
| **Manage (HTTP API)** | Shipped | `POST /manage/sessions`, … |
| **Manage (CLI)** | **Not implemented** | — |

The core orchestration loop is unchanged. Manage never runs planner → dev → verifier or opens PRs.

---

## Web UI (`/manage`)

When `helix serve` is running:

- **Run** (`/`) — submit issues, watch specialist events, view deliverable
- **Manage** (`/manage`) — single prompt box; chat with the meta agent; preview drafts and deletions; **Apply** / **Discard**

Capabilities today:

- Create or update `.helix/agents/*.md`
- Create or update `.helix/skills/<name>/SKILL.md`
- Propose deletions (skills anytime; workflow agents only with force)
- List current agents/skills in the inventory panel

Requires `OPENROUTER_API_KEY` (or configured provider) for live LLM calls.

---

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/manage/agents` | List agents |
| `GET` | `/manage/skills` | List skills |
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
- Paths restricted to `.helix/agents/` and `.helix/skills/`.
- Agents listed in `config.orchestrator.workflow` cannot be deleted unless `force: true`.
- Skill deletion removes the entire `skills/<name>/` directory.

---

## Related code

| Area | Files |
|------|--------|
| Manage core | `src/manage/{service,author,prompt,validate,apply,delete}.ts` |
| Server routes | `src/server/app.ts` |
| Web UI | `src/server/public/manage.{html,js}` |
| Tests | `test/manage.test.ts` |

---

## Non-goals (current)

- No `config.json` workflow auto-patch (agent mentions manual steps only)
- No token streaming from the manage agent
- No CLI REPL
- No subprocess / global pi skill publishing
