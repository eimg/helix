# Repo context & cold-start problem

**Status:** Phase A implemented (deterministic bootstrap + context allowlist). Phases B–D still open.

Every Helix run today starts cold: the planner (and often dev) must re-explore the repository from scratch. This doc captures why that happens, the cost, and candidate solutions. Prefer **repo-local artifacts** over cross-run session persistence — consistent with Helix's isolated-session model.

---

## Problem

On each run, especially the **planner** specialist, agents spend significant time and tokens using `read`, `grep`, `find`, `ls`, and `bash` to understand project layout, conventions, and where code lives — even when the repo has not changed since the last run.

Symptoms:

- High latency before useful output (plan or code)
- Redundant token/tool cost on every issue
- Inconsistent plans when exploration paths differ between runs

---

## Root causes (current architecture)

These stack together; fixing one alone helps only partially.

| Factor | Where | Effect |
|---|---|---|
| **Fresh sessions per run** | `PiSpecialistSessionFactory` uses `SessionManager.inMemory()` | No memory from prior runs or prior issues |
| **Session isolation** | `loaderBuilder.ts` sets `noContextFiles: true` | pi does not auto-load `AGENTS.md`, README, or other context files |
| **Planner prompt** | `.helix/agents/planner.md` | Explicitly instructs "Read the repo as needed to ground the plan" |
| **Tool-free orchestrator** | `orchestrator/driver.ts` | Orchestrator cannot pre-read the repo; first repo contact is a specialist |
| **Handoff = issue + prior results only** | Engine / driver | No injected repo skeleton or accumulated repo knowledge |

Within a single run, the orchestrator passes planner output to dev, but **between runs** nothing persists except run JSON under `.helix/runs/` (issue, events, deliverable — not a reusable repo map).

---

## Design constraint

Helix intentionally keeps specialists **isolated** (own session, no inter-specialist chat). Cross-run **session resume** is possible in pi but conflicts with:

- Per-issue independence and auditability
- Stale assumptions after refactors
- Portability (essentials in `.env` / pi; sessions always isolated)

**Preferred direction:** inject **deterministic or curated artifacts** before the first specialist tool call, and optionally **accumulate** learnings into version-controlled files under `.helix/` — not resume opaque session state.

---

## Candidate solutions

Roughly ordered by complexity and fit with Helix.

### 1. Deterministic bootstrap (pre-run, no LLM)

Before specialists start, Helix gathers a fixed **repo skeleton** and injects it into the first orchestrator handoff (or directly into planner task):

- Top-level directory tree (depth-limited)
- `package.json` / workspace manifest summaries
- Known scripts (`test`, `build`, `lint`)
- Default branch, optional recent changed files vs `main`
- Excerpts from `AGENTS.md` / `README.md` if present

**Pros:** Cheap, fast, predictable.  
**Cons:** Structural only — does not answer "where is auth implemented?" without further reads.

### 2. Helix-owned context files (without global pi inheritance)

Load a **curated allowlist** of repo files into specialist sessions (sessions stay isolated from pi globals):

- `AGENTS.md`, `README.md`, `docs/plan.md`
- Optional `.helix/context/*.md` (operator-maintained)

Distinct from loading all of pi's global skills/context — keeps portability, adds repo bootstrap.

**Pros:** Simple; rewards good repo docs.  
**Cons:** Token cost every run; useless if docs are missing or stale.

### 3. Persistent repo memory artifact (amortized learning)

Maintain `.helix/repo-memory.md` (or structured JSON) updated across runs:

- Architecture summary, key paths, verified commands, conventions
- Planner **reads first**, explores only gaps, appends a **delta** section at end
- Optional human edit / review before merge to main

Invalidation triggers (TBD): merge to default branch, memory age, large diff stats, manual `helix index`.

**Pros:** Best long-term ROI for busy repos; version-controlled; human-in-the-loop.  
**Cons:** Staleness after refactors; needs clear invalidation rules.

### 4. Offline / scheduled indexing

`helix index` (CLI) or CI hook runs a dedicated indexer agent that refreshes repo memory or a structured index. Normal runs **consume** the index; they do not rediscover from zero.

**Pros:** Moves exploration off the critical path of `helix run` / poll trigger.  
**Cons:** Another pipeline; freshness is a product concern.

### 5. Workflow routing — skip planner when safe

Orchestrator or a cheap gate skips planner for trivial issues (typo, dep bump, single-file config) and sends issue + bootstrap straight to dev.

**Pros:** Saves worst-case cost without solving the general problem.  
**Cons:** Mis-routing is expensive; needs confidence thresholds.

### 6. Structured planner contract (within-run + artifact seed)

Require planner output to include a **Repo facts** section: verified commands, files/modules, patterns. Orchestrator passes this to dev; promote stable facts into `.helix/repo-memory.md`.

**Pros:** Reduces duplicate exploration inside a run; feeds #3.  
**Cons:** Does not alone fix between-run cold start.

### 7. Semantic index (RAG)

Local embeddings + retrieval for large monorepos. Planner queries instead of blind grep tours.

**Pros:** Scales past markdown memory.  
**Cons:** Highest complexity; embedding and index maintenance cost; retrieval errors.

### 8. Cross-run session persistence (discouraged as default)

Persist pi sessions to disk and resume planner context next run.

**Pros:** True continuity.  
**Cons:** Fights isolation model; stale context; hard to audit per issue. Consider only for an opt-in "repo steward" role, not default specialists.

---

## What does not fully solve it

- **Better planner prompt** — still explores; only efficiency gains
- **Cheaper/faster model** — lowers cost, not redundancy
- **Turning on global pi inheritance alone** — does not give Helix-specific cross-run memory; sessions stay intentionally isolated

---

## Recommended phased approach (when we implement)

| Phase | Scope | Notes |
|---|---|---|
| **A** | Deterministic bootstrap + Helix-owned context file allowlist | **Shipped** — `src/context/bootstrap.ts`; config `repoContext`; injected into orchestrator + first specialist wave |
| **B** | `.helix/repo-memory.md` read/write contract; planner delta updates | Amortize cost across runs |
| **C** | Freshness: re-index on merge to main, age/diff thresholds, optional `helix index` | Operational |
| **D** | Semantic index | Only if repos outgrow markdown memory |

---

## Open questions

- Who writes repo memory — planner only, dedicated indexer specialist, or deterministic + LLM merge?
- Config surface: `config.json` keys for bootstrap depth, context allowlist, memory path, invalidation policy?
- Should bootstrap run once per **run** (orchestrator injects) or once per **specialist** invocation?
- Token budget cap for injected context vs. "explore yourself" fallback?
- Git-aware delta: inject changed files vs `main` for incremental issues?

---

## Related code & docs

- Session factory: `src/agents/session.ts`
- Isolation contract: `src/agents/loaderBuilder.ts`
- Orchestrator handoffs: `src/orchestrator/driver.ts`
- Planner agent: `.helix/agents/planner.md` (and presets)
- Milestone tracking: [`docs/plan.md`](./plan.md) (M3+)
