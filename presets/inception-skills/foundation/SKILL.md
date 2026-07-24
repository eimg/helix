# Inception foundation

Conventions for Helix empty-workspace bootstrap from a Prelude `prelude.bootstrap.v1` export.

## Pickup

- Authoritative file: `bootstrap.json` (`schemaVersion: prelude.bootstrap.v1`).
- Freeform `documents/` are suggestions, not a rigid schema.
- There is no required target path in the export — the operator supplies `--target`.

## Fixed roles

1. **architect** — interpret export → foundation plan / conflict questions
2. **scaffolder** — materialize target workspace + Helix init wiring
3. **validator** — run foundation checks; fail closed to Prelude on conflict

Do not reuse implementation `planner`/`dev` or PR `reviewer`/`verifier` for inception.

## Materialize baseline

Prefer:

- Copy export `documents/` under `docs/inception/` (or plan-specified layout)
- Preserve artifacts and Primer note snapshots as context, not as code truth
- `git init` when the target is new
- `helix init` (or shared scaffold) for `.helix/` agents, PR agents, inception agents, and skills

## Failure mode

If the export is incomplete or scaffolding exposes a foundational conflict, emit structured evidence for the human to revise in Prelude. Do not invent a replacement architecture.
