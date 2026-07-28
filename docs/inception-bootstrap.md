# Inception bootstrap (empty workspace)

**Status:** Empty-workspace entry, deterministic materialize, and fixed-role
specialist execution (architect → scaffolder → validator) are shipped.
Durable SSE progress and export-catalog conflict round-trips are next.

Prelude (or any compatible authoring surface) owns new-project drafting and
exports `prelude.bootstrap.v1` as a versioned package. Helix owns one-time
empty-workspace execution. There is no authoring-tool → Helix trigger.

**Happy path:** the operator opens an empty folder and runs Helix there.

```text
empty folder
  → helix bootstrap --export … | --export-url … | --export-catalog … --export-id …
     --execute
     or helix serve  (scaffolds .helix; bootstrap --execute still creates git)
  → materialize: .git + .helix + docs/inception
  → agents: architect → scaffolder → validator (inception skills auto-loaded)
  → foundation plan + scaffold + validation
  → best-effort POST {catalog}/api/exports/:id/adopt when sourced from a catalog
```

Materialize alone is **not** “completed.” Until agents succeed, workspace
state is `awaiting_agents` (resume with `--run-agents` or the Bootstrap UI).

This path is separate from:

- **Repo context bootstrap** (`src/context/bootstrap.ts`) — grounds agents in an *existing* repo
- **Implementation runs** — `.helix/agents/` + `orchestrator.workflow`
- **PR control** — `.helix/pr-agents/` reviewer + verifier

## Rules

1. **No prior git host required.** Inception starts in an empty workspace.
2. **Target defaults to the current folder** (`--target` optional).
3. **Execute creates a new git repository in place** for the new project.
4. Target must not already own `.git`.
5. Target must be empty aside from allowed stubs (`.DS_Store`, `.env`,
   `.env.example`, `.gitignore`, and a Helix scaffold from `helix serve`
   including `.helix/.env` / `.helix/.env.example`).
6. Inception agents resolve from **package presets** until project
   `.helix/inception-agents/` overrides exist.
7. Inception skills under `.helix/inception-skills/` (else package
   `presets/inception-skills/`) auto-load into bootstrap specialist sessions.
8. **`OPENROUTER_API_KEY` is required for execute / run-agents** (`.helix/.env`
   or pi auth). Materialize still needs an export source; agents need auth.
9. Export pickup is a **soft contract** (`prelude.bootstrap.v1` + optional HTTP
   catalog). Helix does not hard-depend on any authoring product; UI language
   talks about “bootstrap export” / “export catalog.”

## Fixed roles

| Role | Responsibility |
|---|---|
| `architect` | Interpret bootstrap export → foundation plan / conflict questions |
| `scaffolder` | Materialize target workspace + Helix wiring |
| `validator` | Check foundation; fail closed on conflict |

Optional order in `.helix/config.json`:

```json
{
  "inception": {
    "roles": ["architect", "scaffolder", "validator"]
  }
}
```

## CLI

```bash
mkdir my-app && cd my-app
helix init   # or: helix serve  (scaffolds .helix including .env.example)
cp .helix/.env.example .helix/.env   # set OPENROUTER_API_KEY

# Validate pickup (no writes) — local path
helix bootstrap --export /path/to/exports/<id>/v<n> --dry-run

# Or pull a packaged export / catalog entry
helix bootstrap --export-url http://127.0.0.1:8318/api/exports/1/package --dry-run
helix bootstrap --export-catalog http://127.0.0.1:8318 --export-id 1 --execute

# If materialize already finished, resume agents only
helix bootstrap --run-agents [--export …]

# Or start the UI first in the empty folder (scaffolds .helix, no git yet)
helix serve
# then pick an export and Execute from /bootstrap
```

Authoritative pickup file: `bootstrap.json` with
`schemaVersion: "prelude.bootstrap.v1"`.
See the companion [`bootstrap-contract.md`](https://github.com/eimg/prelude/blob/main/docs/bootstrap-contract.md)
(format + optional HTTP catalog).

Execute steps:

1. Resolve export (local path, package URL, or catalog id → download/tar extract)
2. `git init` in the target workspace
3. Copy brief / documents / artifacts / Primer notes under `docs/inception/`
4. Write a starter `README.md` when missing
5. `helix init` (agents, PR agents, inception agents/skills, config)
6. Seed `.helix/context/inception.md`
7. Run architect → scaffolder → validator (writes `FOUNDATION_PLAN.md` / `VALIDATION.md`)
8. Persist job status under `.helix/inception/job.json`
9. Commit the scaffolded foundation on `main` so later implementation runs can open isolated local PRs
10. When sourced from a catalog, best-effort `POST …/api/exports/:id/adopt`

Flags: `--preset <stack>` (default `typescript`), `--force` (allow non-empty foreign files / overwrite Helix scaffolding).

## Manage & Config

- `helix serve` in an empty folder scaffolds `.helix/` so Manage/Config work before git exists
- Manage inventories bootstrap agents and skills; Config shows effective skills, auto-load, and skill paths
- Bootstrap sessions auto-load `.helix/inception-skills/` (package presets until project skills exist)
- Local PR deliverable waits until git exists (after bootstrap `--execute`); a long-lived `helix serve` upgrades from NoOp → local PR automatically once bootstrap leaves a base commit

## Web UI & HTTP

When HTTP auth is enabled, export catalog reads require `helix.bootstrap` and
the selected auth adapter resolves the human principal. Helix uses its scoped
Prelude service token only for catalog origins listed in
`HELIX_TRUSTED_PRELUDE_ORIGINS`; other compatible catalogs remain usable
without receiving that credential.

- `GET /workspace` — `bootstrap.state` is `ready` | `awaiting_agents` | `running` | `completed` | `failed` | `blocked`
  - `bootstrap.available` — fresh execute allowed (empty / no git)
  - `bootstrap.visible` — nav/page shown: empty ready **or** existing git with Helix bootstrap artifacts
  - `bootstrap.hasArtifacts` — `docs/inception/`, inception context, or `.helix/inception/job.json`
  - Existing git **without** artifacts → `blocked` (Bootstrap disabled, PR Reviews on)
  - Existing git **with** artifacts → Bootstrap stays visible as a receipt / resume surface; re-execute is never allowed once `completed`
- `GET /bootstrap/export-catalog?baseUrl=&status=` — proxy soft catalog list (`all` in Bootstrap UI; adopted remains selectable)
- `GET /bootstrap/export-catalog/status?baseUrl=` — soft reachability (`online` / `offline` / `unconfigured`) via `/api/health` or `/health`
- `POST /bootstrap` — `{ exportPath | exportUrl | exportCatalogUrl+exportId, dryRun? | execute? | runAgents?, force?, preset? }`
  - dry-run / execute only when `available`
  - runAgents when `canRunAgents` (awaiting / failed)
  - execute / runAgents → 202 accepted job (agents continue in background); poll `/workspace`
- Nav: **Bootstrap** uses `visible` (not merely git); **PR Reviews** disabled on empty non-git workspaces
- Page: `/bootstrap` — Export catalog | Local path | Package URL; catalog lists exports with summary + All/New/Adopted filter

## Next slices

1. SSE progress while specialists run (UI currently polls `/workspace`)
2. Structured conflict report for export-catalog revision
3. Optional Acme Issues seed after foundation is valid
