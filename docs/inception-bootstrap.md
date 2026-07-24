# Inception bootstrap (empty workspace)

**Status:** Empty-workspace entry, deterministic materialize, and fixed-role
specialist execution (architect → scaffolder → validator) are shipped.
Durable SSE progress and Prelude conflict round-trips are next.

Prelude owns new-project drafting and exports `prelude.bootstrap.v1` under its
local data directory. Helix owns one-time empty-workspace execution. There is
no Prelude → Helix trigger.

**Happy path:** the operator opens an empty folder and runs Helix there.

```text
empty folder
  → helix bootstrap --export … --execute
     or helix serve  (scaffolds .helix; bootstrap --execute still creates git)
  → materialize: .git + .helix + docs/inception
  → agents: architect → scaffolder → validator (inception skills auto-loaded)
  → foundation plan + scaffold + validation
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
   or pi auth). Materialize still needs an export path; agents need auth.

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
helix init   # or: helix serve  (scaffolds .helix including .env.example)
cp .helix/.env.example .helix/.env   # set OPENROUTER_API_KEY

# Validate Prelude pickup (no writes)
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --dry-run

# Materialize + run inception agents
helix bootstrap --export /path/to/prelude/data/exports/<id>/v<n> --execute

# If materialize already finished, resume agents only
helix bootstrap --run-agents [--export …]

# Or start the UI first in the empty folder (scaffolds .helix, no git yet)
helix serve
# then Execute (or Run inception agents) from /bootstrap
```

Authoritative pickup file: `bootstrap.json` with
`schemaVersion: "prelude.bootstrap.v1"`.
See Prelude's [`bootstrap-contract.md`](https://github.com/eimg/prelude/blob/main/docs/bootstrap-contract.md).

Execute steps:

1. `git init` in the target workspace
2. Copy brief / documents / artifacts / Primer notes under `docs/inception/`
3. Write a starter `README.md` when missing
4. `helix init` (agents, PR agents, inception agents/skills, config)
5. Seed `.helix/context/inception.md`
6. Run architect → scaffolder → validator (writes `FOUNDATION_PLAN.md` / `VALIDATION.md`)
7. Persist job status under `.helix/inception/job.json`
8. Commit the scaffolded foundation on `main` so later implementation runs can open isolated local PRs

Flags: `--preset <stack>` (default `typescript`), `--force` (allow non-empty foreign files / overwrite Helix scaffolding).

## Manage & Config

- `helix serve` in an empty folder scaffolds `.helix/` so Manage/Config work before git exists
- Manage inventories bootstrap agents and skills; Config shows effective skills, auto-load, and skill paths
- Bootstrap sessions auto-load `.helix/inception-skills/` (package presets until project skills exist)
- Local PR deliverable waits until git exists (after bootstrap `--execute`); a long-lived `helix serve` upgrades from NoOp → local PR automatically once bootstrap leaves a base commit

## Web UI & HTTP

- `GET /workspace` — `bootstrap.state` is `ready` | `awaiting_agents` | `running` | `completed` | `failed` | `blocked`
  - `bootstrap.available` — fresh execute allowed (empty / no git)
  - `bootstrap.visible` — nav/page shown: empty ready **or** existing git with Helix bootstrap artifacts
  - `bootstrap.hasArtifacts` — `docs/inception/`, inception context, or `.helix/inception/job.json`
  - Existing git **without** artifacts → `blocked` (Bootstrap disabled, PR Reviews on)
  - Existing git **with** artifacts → Bootstrap stays visible as a receipt / resume surface; re-execute is never allowed once `completed`
- `POST /bootstrap` — `{ exportPath, dryRun? | execute? | runAgents?, force?, preset? }`
  - dry-run / execute only when `available`
  - runAgents when `canRunAgents` (awaiting / failed)
  - execute / runAgents → 202 accepted job (agents continue in background); poll `/workspace`
- Nav: **Bootstrap** uses `visible` (not merely git); **PR Reviews** disabled on empty non-git workspaces
- Page: `/bootstrap`

## Next slices

1. SSE progress while specialists run (UI currently polls `/workspace`)
2. Structured conflict report for Prelude revision
3. Optional Acme Issues seed after foundation is valid
