# Inception bootstrap (empty workspace)

**Status:** Empty-workspace entry + deterministic materialize shipped. Specialist
execution, durable jobs, and Issues seeding are next.

Prelude owns new-project drafting and exports `prelude.bootstrap.v1` under its
local data directory. Helix owns one-time empty-workspace execution. There is
no Prelude → Helix trigger.

**Happy path:** the operator opens an empty folder and runs Helix there.

```text
empty folder
  → helix bootstrap --export … --execute
     or helix serve  (scaffolds .helix; bootstrap --execute still creates git)
  → new project in place: .git + .helix + docs/inception
```

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
   `.env.example`, `.gitignore`, and a Helix scaffold from `helix serve`).
6. Inception agents resolve from **package presets** until project
   `.helix/inception-agents/` overrides exist.
7. Inception skills under `.helix/inception-skills/` (else package
   `presets/inception-skills/`) auto-load into bootstrap specialist sessions.

## Fixed roles

| Role | Responsibility |
|---|---|
| `architect` | Interpret Prelude export → foundation plan / conflict questions |
| `scaffolder` | Materialize target workspace + Helix wiring |
| `validator` | Check foundation; fail closed back to Prelude on conflict |

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

# Validate Prelude pickup (no writes)
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --dry-run

# Create git + Helix project + inception docs in this folder
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --execute

# Or start the UI first in the empty folder (scaffolds .helix, no git yet)
helix serve
# then in another terminal, from the same folder:
helix bootstrap --export … --execute
```

Authoritative pickup file: `bootstrap.json` with
`schemaVersion: "prelude.bootstrap.v1"`.
See Prelude's [`bootstrap-contract.md`](https://github.com/eimg/prelude/blob/main/docs/bootstrap-contract.md).

Execute materialize steps:

1. `git init` in the target workspace
2. Copy brief / documents / artifacts / Primer notes under `docs/inception/`
3. Write a starter `README.md` when missing
4. `helix init` (agents, PR agents, inception agents/skills, config)
5. Seed `.helix/context/inception.md`

Flags: `--preset <stack>` (default `typescript`), `--force` (allow non-empty foreign files / overwrite Helix scaffolding).

## Manage & Config

- `helix serve` in an empty folder scaffolds `.helix/` so Manage/Config work before git exists
- Manage inventories bootstrap agents and skills; Config shows effective skills, auto-load, and skill paths
- Bootstrap sessions auto-load `.helix/inception-skills/` (package presets until project skills exist)
- Local PR deliverable waits until git exists (after bootstrap `--execute`)

## Web UI & HTTP

- `GET /workspace` — git/empty status; `bootstrap.available` when no `.git`; `prReviews.available` when git exists
- `POST /bootstrap` — `{ exportPath, dryRun? | execute?, force?, preset? }` against the server cwd
- Nav: **Bootstrap** shown but disabled on existing git repos; **PR Reviews** shown but disabled on empty non-git workspaces
- Page: `/bootstrap`

## Next slices

1. Durable bootstrap job + SSE progress while specialists run
2. Run fixed-role specialists against an accepted plan
3. Structured conflict report for Prelude revision
4. Optional Acme Issues seed after foundation is valid
