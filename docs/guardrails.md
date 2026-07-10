# Guardrails & escalation

**Status:** Design note — not implemented (beyond existing hard gates). Revisit when adding Settings, stronger safety, or human-in-the-loop resume.

This doc captures considerations and a phased path so future work does not rediscover the problem space. It pairs two topics that should stay aligned: **what must not happen** (guardrails) and **what happens when the loop cannot continue** (escalation).

Related: [`plan.md`](./plan.md), [`repo-context.md`](./repo-context.md), [`manage.md`](./manage.md).

---

## Current state (what already exists)

| Mechanism | Where | Behavior |
|---|---|---|
| Workflow rails + LLM orchestrator | `orchestrator/driver.ts`, config `workflow` / `loops` | Soft guidance; may skip/reorder |
| Iteration cap | `orchestrator/gates.ts` | Forces `escalate` |
| Blocking-failure gate | `engine/engine.ts` | `done` over failed specialist → escalate |
| Merge gate + approval | `mergeGate.ts`, deliverable pipeline, approve/reject API | Size/risk → auto-merge or `approvalStatus: pending` |
| `deliverable.pr` (default `false`) | config + `cli.ts` serve wiring | No `gh pr create` unless opted in |
| Extensions default off | config, `loaderBuilder.ts` | Less ambient privilege |
| Session isolation | specialist/orchestrator sessions | No inter-specialist chat; no global pi skills/context files |
| Agent `tools:` frontmatter | `.helix/agents/*.md` | Declares tools; **not** a hard global policy layer |

### Escalation today (gap)

```ts
{ kind: "escalate"; reason: string }
→ run.status = "escalated" → emit run_escalated → stop
```

There is **no** category, severity, suggested action, resume path, or notification contract. Merge **approval** is a separate, structured pause; escalation is only a terminal string. Orchestrator errors, iteration caps, policy-like stops, and “needs a human decision” all collapse into one bucket.

---

## Threat model (decide before implementing)

Clarify which of these you are protecting against:

1. **Model mistakes** — wrong edits, runaway loops, accidental `gh` / destructive bash (primary for local demos).
2. **Malicious or injected prompts** — issue body / tracker content trying to exfiltrate or escape the repo.
3. **Exposed `helix serve`** — anything beyond `127.0.0.1` needs auth; localhost single-operator can defer this.

Default assumption for Helix’s current use (local-issues + localhost serve): optimize for (1), harden lightly for (2), defer (3) until bind address leaves loopback.

---

## Guardrails — what to consider

### 1. Blast radius (filesystem / shell)

- Enforce tool allowlists (don’t rely on frontmatter alone).
- Workspace jail: operations limited to repo cwd; block `~/.ssh`, `.env` exfil patterns, paths outside root.
- Command policy: deny `sudo`, destructive rm patterns, or optional bash allowlist.
- Caps: max files touched / max diff lines per run.

### 2. Side effects outside the repo

- Git push / PR / merge — already opt-in via `deliverable.pr`; keep fail-closed.
- Issue-tracker / webhook callbacks — URL allowlist, auth (today: POC, no auth).
- Outbound network via `bash` (curl, etc.).

### 3. Cost & runaway

- Iteration cap (exists).
- Wall-clock, specialist turns, token/cost budget per run.
- Concurrent run limit on serve.
- Model tier caps (cheap orchestrator vs stricter verifier).

### 4. Human gates

- Merge approval (exists).
- Optional **plan approval** before `dev`.
- Optional approval for policy exceptions (e.g. allow one denied path).

### 5. Trust boundaries (serve)

- Who can `POST /runs`, Manage apply, DELETE runs, future Settings.
- Bind host from config; secrets never in run JSON / UI / logs.

### Design principles

1. **Deterministic beats prompt** — gates enforce; prompts only prefer.
2. **Fail closed for side effects** — PR, merge, webhooks off unless enabled.
3. **Same policy for CLI and serve** — one policy object.
4. **Observable** — emit `gate_blocked` / `policy_denied` (or structured escalation), not silent stalls.
5. **Layered config** — essentials (`.env` / pi) separate from wiring (`.helix/config.json`) → optional per-run override later.

### Suggested config sketch (future)

```jsonc
"guardrails": {
  "mode": "demo" | "standard" | "github",  // presets → concrete flags
  "maxRunMinutes": 30,
  "maxSpecialistTurns": 40,
  "fs": { "rootOnly": true },
  "tools": { "deny": [] },
  "sideEffects": { "pr": false, "webhooks": true }
}
```

Map `mode` to defaults so “local-issues demo” vs “GitHub PR mode” is one switch. Fold `deliverable.pr` into this story so operators are not hunting multiple knobs.

### Phased implementation (guardrails)

| Phase | Scope |
|---|---|
| **0** | Policy surface + presets; document demo vs github |
| **1** | Enforce at owned boundaries: budgets in engine; tool filter in session factory; deliverable/callback gates; serve bind/route checks |
| **2** | Tool wrappers for `bash` / `write` / `edit` (cwd jail, deny patterns, clear deny events) |
| **3** | Human checkpoints (plan gate) reusing approval/escalation pause UX |
| **4** | Authn for non-localhost serve; webhook HMAC |

**Priority for current local-issues demos:** side-effect defaults (done for PR) → run budgets → workspace jail → demo/github preset → Settings UI later.

**Defer early:** multi-tenant auth, full VM sandbox, OPA-style engines.

---

## Escalation — concrete model (proposal)

Escalation should become a **first-class outcome** (and optionally a **pausable state**), not only `{ reason: string }`.

### Proposed shape

```ts
type EscalationCode =
  | "needs_human_decision"  // product / ambiguous requirements
  | "policy_denied"         // guardrail blocked an action
  | "budget_exceeded"       // turns / time / tokens / iterations
  | "specialist_failed"     // unrecoverable after loops
  | "orchestrator_error"    // LLM / parse / infra
  | "deliverable_blocked"   // merge gate / PR path failure
  | "external_blocked";     // tracker / gh unavailable when required

interface Escalation {
  code: EscalationCode;
  severity: "info" | "warning" | "critical";
  reason: string;
  source: "orchestrator" | "gate" | "engine" | "deliverable" | "policy";
  blocking?: string[];
  suggestedAction?:
    | "reply_and_resume"
    | "approve_plan"
    | "approve_merge"
    | "edit_config"
    | "retry"
    | "close";
  resumeToken?: string;
  details?: Record<string, unknown>;
}
```

Decision (future):

```ts
| { kind: "escalate"; escalation: Escalation; reason?: string }
```

Keep a top-level `reason` mirror for back-compat with UI/logs if needed.

### Two modes

| Mode | Status | When |
|---|---|---|
| **Terminal** | `escalated` | Infra error, hard budget, unrecoverable failure |
| **Paused** | `awaiting_human` | Needs decision, plan approval, policy exception |

Suggested statuses:

```ts
"running" | "awaiting_human" | "done" | "escalated" | "error"
```

- `awaiting_human` — resumable (same family as merge `approvalStatus: pending`).
- `escalated` — closed; new run or explicit reopen.
- `error` — unexpected throw; keep distinct from deliberate escalate.

**Do not conflate merge approval with escalation.**  
Approval = work looks done, need sign-off. Escalation = cannot continue the orchestration loop.

### Source → code mapping

| Event | Code | Default mode |
|---|---|---|
| Orchestrator: ambiguous / risky product call | `needs_human_decision` | pause |
| Tool/path/command blocked by policy | `policy_denied` | pause or terminal (config) |
| Iteration / time / token cap | `budget_exceeded` | terminal |
| Verifier fail past maxRetries | `specialist_failed` | terminal or pause |
| Unparseable JSON / LLM down | `orchestrator_error` | terminal |
| Merge gate pending | **approval**, not escalate | pause (exists) |
| `gh` failed while `deliverable.pr` true | `deliverable_blocked` | terminal |
| local-issues completion webhook failed | usually **not** escalate — log callback failure | — |

### Operator contract (future)

1. **Surface** — Run UI: code badge + reason + suggested action.
2. **Notify** — optional `run.escalated` / `run.awaiting_human` to local-issues with structured payload.
3. **Resume** (paused only) — e.g. `POST /runs/:id/resume` with `{ reply }` or `{ decision }`; inject as human input into orchestrator and continue.
4. **Close** — abandon without resume.

### Phased implementation (escalation)

| Phase | Scope |
|---|---|
| **A** | Structured `Escalation` on decisions/gates; persist; show in UI; **still terminal** |
| **B** | `awaiting_human` + resume API + orchestrator consumes human reply |
| **C** | Tracker notifications; policy denials always emit `policy_denied` with details |
| **D** | Presets: demo (pause + notify) vs github (escalate + optional issue comment / draft PR) |

**Recommended start:** Phase A only — gives local-issues and the UI signal without inventing resume yet.

---

## How guardrails and escalation connect

- Guardrails **detect/deny**; escalation **classifies and routes** the stop (or pause).
- A policy deny should not be a free-text `reason` only — use `code: "policy_denied"` + `details` (tool, path, rule).
- Soft prompt instructions are not guardrails; if it must not happen, enforce in engine/session/deliverable and escalate with a code.

```
policy / budget / gate trip
        │
        ▼
  structured Escalation
        │
        ├─ terminal → status escalated → notify? → stop
        └─ pause    → awaiting_human → UI / tracker → resume or close
```

---

## Open questions (resolve when implementing)

**Guardrails**

1. Threat model: mistakes only, or also hostile issue text / exposed serve?
2. Bash in demo mode: deny entirely, allowlist, or wrap with filters?
3. Plan approval before `dev` — yes for demos, or only merge approval?
4. Policy home: only `config.json`, or also a human-readable `.helix/policy.md`?
5. On deny mid-tool: fail the tool and let orchestrator adapt, or escalate the whole run?

**Escalation**

1. Ship Phase A (structured, terminal) before pause/resume?
2. Same UX as merge approval, or separate “Respond / Abort” flow?
3. Notify Run UI only, or also local-issues status/comment?
4. Resume with free text, fixed decisions only, or both?

---

## Out of scope for early slices

- Subprocess / VM isolation for untrusted specialists (see AGENTS.md future notes).
- Multi-tenant SaaS auth.
- Replacing merge approval with escalation (keep both concepts).
- Making completion-webhook failures escalate the run by default.

---

## Implementation touchpoints (when ready)

| Area | Files / surfaces |
|---|---|
| Types | `src/engine/types.ts` — `Escalation`, run status, decision shape |
| Gates | `src/orchestrator/gates.ts`, engine blocking-failure path |
| Orchestrator prompt | `src/orchestrator/driver.ts` — teach codes when emitting escalate |
| Session / tools | `src/agents/session.ts`, `loaderBuilder.ts` — tool policy |
| Deliverable | `src/deliverable/pipeline.ts`, `deliverable.pr` |
| Callbacks | `src/callbacks/issueTracker.ts` — escalated events, auth later |
| UI | `src/server/public/app.js` — badges, resume actions |
| Config | `src/config.ts` — `guardrails` block + presets |
| Docs | Update this file + `plan.md` when phases ship |
