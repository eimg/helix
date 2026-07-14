# Helix — Architecture & substrate strategy

Living document. Captures stack and ownership decisions for exploration → eventual production, without locking Helix to a vendor agent platform.

Related: [`plan.md`](./plan.md) · [`guardrails.md`](./guardrails.md) · [`repo-context.md`](./repo-context.md)

> **Status:** Direction for ongoing exploration. Not a mandate to implement Temporal, OTel, or AI SDK in the current milestone.

---

## Design posture

**Own the product brain; keep plumbing light and swappable.**

Helix is an **orchestration control plane** (workflow rails + LLM driver + deterministic gates + run/event semantics). It is not an LLM, not a coding agent, and not a cloud agent product.

For a small/medium team that values **own infra and portability**:

| Own (Helix identity) | Borrow as libraries | Avoid as core |
|---|---|---|
| Orchestrator policy, gates, escalate/approve | Agent/runtime libraries (**pi** now; **AI SDK** candidate later) | Vendor agent frameworks as the app shape (Eve, ADK, …) |
| Specialist contracts + inventory | Multi-provider model APIs (e.g. OpenRouter) | Building *on* Vercel/Google agent platforms |
| Run/event model, thin checkpoints | Optional later: Temporal-class durability, OTel exporters | Replacing Helix’s loop with a platform’s orchestration model |

**In-house light components by default**, with **ports** so established third-party services can replace adapters when pain is real — not because the landscape is fashionable.

Coding agents may help maintain thin DIY layers (obs, checkpoints, UI). They should not tempt us into reinventing model/tool protocols or a home-grown Temporal forever.

---

## Current seams and target ports

The engine already depends on small interfaces (`Provider`, `Orchestrator`, `SpecialistSessionFactory`, `RunStore`). The remaining names below are **target ports**, not claims that every interface exists today. Core should not import Temporal, OpenTelemetry, Eve, or ADK; optional integrations belong in adapters.

```
Helix core (orchestrator, gates, specialist contracts)
        │
        ├── RunStore (exists)          → SQLite now → Postgres / workflow projection later
        ├── WorkflowRunner (target)    → In-process now     → Temporal / Inngest / … later
        ├── DomainEventSink (target)   → RunEvent bus now   → UI + OTel / Langfuse exporters later
        ├── DecisionRuntime (target)   → pi now             → pi / AI SDK adapter later
        ├── SpecialistRuntime (target) → pi factory now     → pack-specific adapters later
        ├── ToolRegistry (target)      → native tools now   → native + MCP client adapters later
        └── Deliverable / HITL         → approve API now    → signal-based resume later
```

### Rules so “open later” stays real

1. **Versioned domain events are the integration language** (`RunEvent`). UI and future exporters consume them; durable `Run` state/checkpoints remain the source of truth unless Helix deliberately adopts event sourcing.
2. **Durability seam** = explicit step + checkpoint + idempotent effects + pause/resume — not one opaque `Promise` for the whole run. LLM calls, tools, git, PRs, and callbacks need stable invocation identities before replay is safe.
3. **Separate decision and specialist runtimes.** The orchestrator needs structured, tool-free decisions; specialists need pack-specific sessions, tools, context, activity, and policy. Pi and AI SDK may back either port, but are not assumed to be drop-in equivalents.
4. **Tools are a host concern.** Helix combines native tools and MCP-provided tools behind one registry/executor and enforces policy at the host; MCP servers do not replace the tool layer.
5. **Telemetry is derived.** OTel/LLM-ops adapters translate domain lifecycle events and runtime-native spans; they are not the durable run store.
6. **Swap when pain is measurable** (crash loss, concurrent long runs, need for standard dashboards) — not when a blog post is exciting.
7. DIY layers are **scaffolding with swap points**, not a permanent refusal of established engines.

### Near-term vs later (exploration)

| Concern | Exploration (now) | Later (when needed) |
|---|---|---|
| Agent runtimes | **pi** for decisions + coding specialists | Split adapters; keep pi for coding and evaluate **AI SDK** for general packs |
| Tools | pi/native runtime tools | One policy-aware registry with native and MCP client adapters |
| Observability | Durable `RunEvent` + live-only SSE deltas + console | Domain-event exporter plus runtime-native OTel/LLM-ops spans |
| Durability | Incremental SQLite run/events/results (not replay checkpoints) | Explicit step/checkpoint runner behind `WorkflowRunner` |
| AI SDK in mainline | **No** — premature dual runtime | Yes when leaving coding-only or cutting a portable spine |
| OTel / Temporal in mainline | **No** — shape seams first | Yes when in-process + JSON checkpoint is insufficient |

---

## Two product tracks, one spine

Same Helix core and ports; **specialist packs** differ.

| Layer | Coding-specific | General / business-tailored |
|---|---|---|
| Orchestration | Helix | Helix |
| Durability / obs | Thin now → Temporal + OTel later | Same |
| Specialists | **pi** (tools, skills, sessions) | Leading candidate: **AI SDK** + domain tools; native and MCP adapters |
| Optional later | AI SDK + open sandbox if pi is retired as core | Coding pack remains optional |

**Conclusion:** current Helix + later durability/observability adapters can go far for **coding**. For general-purpose packs, AI SDK is the leading candidate when evaluations show that pi's coding-oriented runtime is a poor fit. The specialist contract, tool-policy requirements, provider coverage, and regression evals should decide that choice. Replacing pi on the coding track is a **substrate** choice, not what unlocks durability.

---

## Landscape notes (what we considered)

Studied for fit with Helix; not an adoption list.

| Option | Layer | Role vs Helix |
|---|---|---|
| Bare OpenAI SDK (`openai`) | API client | Too thin; multi-provider DIY |
| **Vercel AI SDK** | Open-source, provider-oriented agent toolkit | Leading **substrate** candidate for general packs; adopting the library does not require Vercel hosting, Gateway, or Workflow |
| OpenAI Agents SDK | OpenAI-default, provider-extensible agent framework | Handoffs/guardrails/tracing; custom model providers exist, but OpenAI remains the default path — study, not default core |
| **pi** | Coding agent runtime | Current core; right while coding-first |
| Eve | Durable agent *product* framework (on AI SDK) | Strong patterns; **platform gravity** — study / optional deploy target, not Helix core |
| Google ADK | Open-source multi-agent orchestration framework | Closest *peer* to Helix's job; local execution is possible, while its surrounding deployment ecosystem is Google-heavy — **study architecture**, don't build *on* ADK by default |
| Temporal (and lighter job runners) | Durable execution | Natural map to explicit engine steps, idempotent effects, and HITL signals — **later adapter**, not a wrapper around today's `startRun` promise |
| OpenTelemetry | Vendor-neutral telemetry | Export path for high-level Helix lifecycle spans plus runtime-native model/tool spans — **later**; not the run-state source of truth |

**Platform gravity:** distinguish open-source libraries from their vendors' hosted products. Vercel/Google clouds may host *capacity* later (sandbox, models, deploy), but hosted control planes must not become the **source of truth** for Helix orchestration policy.

### Adjacent opportunities (not yet designed in)

Worth a future pass; out of scope for this doc’s decisions:

- MCP client adapters as one source of standard tool packs; Helix remains the host and policy boundary
- LLM-specific obs (Langfuse et al.) alongside OTel
- Lighter durability (Inngest/Trigger/etc.) vs Temporal for small teams
- Open sandboxes (Docker/E2B/…) as a coding pack without pi
- Peer skim: LangGraph, Mastra, Claude/OpenAI Agents SDKs
- Evals / regression harnesses
- Subprocess isolation for untrusted specialists ([`plan.md`](./plan.md))

---

## Current codebase alignment

Existing seams are a useful start:

- Engine takes injectable `Provider`, `Orchestrator`, `SpecialistSessionFactory`
- `RunStore` persists normalized SQLite run state and completed full responses; high-volume orchestrator/specialist token deltas remain ephemeral
- Specialist Pi sessions are retained per named lane for a run, while compact `RunKnowledgeEntry` handoffs cross specialist boundaries
- `SpecialistSessionFactory` is the closest current specialist-runtime boundary
- Merge approve/reject is an early HITL surface (post-run today; park/resume later)

Gaps vs this strategy (intentional for exploration):

- `RunContext`, the default orchestrator, and Manage still depend on `PiProvider`; runtime portability is aspirational
- `startRun` is one in-process promise; SQLite records are durable state, not replay-safe workflow checkpoints
- No resume after process death, stable effect/invocation IDs, or idempotency contract
- `RunEvent` has no schema version, sequence/event ID, or causation metadata yet
- No domain-event/observability port beyond the event stream and SQLite store
- No unified tool registry/policy boundary for native and future MCP tools

---

## Explicit non-goals (for this direction)

- Becoming an Eve app or ADK app as the default shape of Helix
- Dual production runtimes (pi **and** AI SDK) without a pack boundary
- OTel-first or Temporal-first rewrites before domain events/steps are stable
- Owning a forever home-grown distributed workflow engine once pain justifies an open standard
