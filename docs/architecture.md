# Helix — Architecture & substrate strategy

Living document. Captures stack and ownership decisions for exploration → eventual production, without locking Helix to a vendor agent platform.

Related: [`vision.md`](./vision.md) · [`plan.md`](./plan.md) · [`guardrails.md`](./guardrails.md) · [`repo-context.md`](./repo-context.md)

> **Status:** Direction for ongoing exploration. Not a mandate to implement general-assistant surfaces, Temporal, OTel, or a second agent runtime in the current milestone.

---

## Design posture

**Own the product brain; keep plumbing light and swappable.**

Helix is an **orchestration control plane** (workflow rails + LLM driver + deterministic gates + run/event semantics). It is not an LLM, not a coding agent, and not a cloud agent product.

For a small/medium team that values **own infra and portability**:

| Own (Helix identity) | Borrow as libraries | Avoid as core |
|---|---|---|
| Orchestrator policy, gates, escalate/approve | **pi** as the default agent harness; alternate runtimes only after evidence | Vendor agent frameworks as the app shape (Eve, ADK, …) |
| Specialist contracts + inventory | Multi-provider model APIs (e.g. OpenRouter) | Building *on* Vercel/Google agent platforms |
| Run/event model, thin checkpoints | Optional later: Temporal-class durability, OTel exporters | Replacing Helix’s loop with a platform’s orchestration model |

**In-house light components by default**, with **ports** so established third-party services can replace adapters when pain is real — not because the landscape is fashionable.

Coding agents may help maintain thin DIY layers (obs, checkpoints, UI). They should not tempt us into reinventing model/tool protocols or a home-grown Temporal forever.

### Platform independence is a product property

Helix core must remain runnable as a local process with filesystem and SQLite state. It must not require a hosted application framework, cloud control plane, vendor-specific agent service, React/Next.js application shape, or Google Cloud deployment topology.

Evaluate dependencies by asking:

1. Can the component run locally and headlessly?
2. Is its important state inspectable and exportable?
3. Can model providers, UI surfaces, and deployment targets change independently?
4. If the vendor account disappears, does Helix remain structurally intact?

Pi fits this posture unusually well: model access, agent loop, sessions, compaction, tools, skills, and extensions are available as local libraries without deciding Helix's UI, channel, workflow, or hosting topology. That independence is a reason to lean into Pi, not merely a temporary coding-era convenience.

---

## Current seams and target ports

The engine already depends on small interfaces (`Provider`, `Orchestrator`, `SpecialistSessionFactory`, `RunStore`). The remaining names below are **target ports**, not claims that every interface exists today. Core should not import Temporal, OpenTelemetry, Eve, or ADK; optional integrations belong in adapters.

```
Helix core (orchestrator, gates, specialist contracts)
        │
        ├── RunStore (exists)          → SQLite now → Postgres / workflow projection later
        ├── WorkflowRunner (target)    → In-process now     → Temporal / Inngest / … later
        ├── DomainEventSink (target)   → RunEvent bus now   → UI + OTel / Langfuse exporters later
        ├── DecisionRuntime (target)   → pi now             → alternate adapter only if justified
        ├── AgentRuntime (target)      → pi session host    → pack/profile-specific configuration
        ├── ToolRegistry (target)      → native tools now   → native + MCP client adapters later
        └── Deliverable / HITL         → approve API now    → signal-based resume later
```

### Rules so “open later” stays real

1. **Versioned domain events are the integration language** (`RunEvent`). UI and future exporters consume them; durable `Run` state/checkpoints remain the source of truth unless Helix deliberately adopts event sourcing.
2. **Durability seam** = explicit step + checkpoint + idempotent effects + pause/resume — not one opaque `Promise` for the whole run. LLM calls, tools, git, PRs, and callbacks need stable invocation identities before replay is safe.
3. **Separate runtime roles, not necessarily runtime libraries.** The orchestrator needs structured, tool-free decisions; workflow specialists need isolated task sessions; conversational assistants need durable thread sessions. Pi can host all three through different profiles. Keep ports clean, but do not add a second runtime merely to demonstrate portability.
4. **Tools are a host concern.** Helix combines native tools and MCP-provided tools behind one registry/executor and enforces policy at the host; MCP servers do not replace the tool layer.
5. **Telemetry is derived.** OTel/LLM-ops adapters translate domain lifecycle events and runtime-native spans; they are not the durable run store.
6. **Swap when pain is measurable** (crash loss, concurrent long runs, need for standard dashboards) — not when a blog post is exciting.
7. DIY layers are **scaffolding with swap points**, not a permanent refusal of established engines.

### Near-term vs later (exploration)

| Concern | Exploration (now) | Later (when needed) |
|---|---|---|
| Agent runtimes | **pi** for decisions + coding specialists | Pi-first conversation and domain-agent profiles; evaluate alternatives only for measured gaps |
| Tools | pi/native runtime tools | One policy-aware registry with native and MCP client adapters |
| Observability | Durable `RunEvent` + live-only SSE deltas + console | Domain-event exporter plus runtime-native OTel/LLM-ops spans |
| Durability | Incremental SQLite run/events/results (not replay checkpoints) | Explicit step/checkpoint runner behind `WorkflowRunner` |
| Second agent SDK in mainline | **No** — premature dual runtime | Only when provider, protocol, deployment, or evaluation evidence requires it |
| OTel / Temporal in mainline | **No** — shape seams first | Yes when in-process + JSON checkpoint is insufficient |

---

## Two product modes, one Pi-first spine

Coding workflows and general assistants need different interaction semantics, but not automatically different agent SDKs.

| Concern | Workflow run | Assistant conversation |
|---|---|---|
| Default path | Orchestrator → specialists → gates → deliverable | Message → persistent Pi session → streamed response |
| Lifetime | Goal-oriented and terminal | Long-lived and conversational |
| Session scope | Isolated run-scoped lanes | Durable thread-scoped session |
| Context | Repository bootstrap + bounded handoffs | User, channel, domain resources, and curated memory |
| Tools | Filesystem, shell, edit, verification | Profile-specific domain tools; coding tools off by default |
| Multi-agent work | Normal when the workflow benefits | Optional escalation for genuinely decomposable work |
| Host state | Run/event/checkpoint model | Thread index, channel mapping, policy, memory metadata |

**Conclusion:** use Pi as the default harness for both modes. General-purpose work should not be forced through the coding orchestrator: most assistant turns should remain in one persistent Pi session, while isolated specialists are an optional execution strategy. Different prompts, tools, resources, memory policies, and session lifetimes define packs. AI SDK or another runtime remains an evaluation fallback, not the planned general-purpose destination.

Issue reopen and command-comment events are **workflow continuations**, not assistant conversation turns. The host creates a linked child run with fresh run-scoped Pi sessions, explicit parent/root IDs, an idempotent external event ID, and bounded context from the original issue plus parent outcome. This preserves isolation and auditability while letting external issue trackers request more work.

## Pull-request lifecycle boundary

Helix implementation workflows and pull-request management are related but distinct control planes.

An issue-driven Helix run owns the path from work item to deliverable:

```text
issue event → isolated implementation run → verification → commit/push → new PR → stop
```

The intended default is that every successful implementation run which changes the repository delivers those changes through a **new pull request**. Direct edits on the current checkout remain acceptable for the local demo stage, but production-oriented PR delivery requires a run-scoped branch or worktree plus deterministic commit and push steps. Helix may attach verification evidence and readiness metadata; it should not decide that its own work must merge.

An independent **PR-control module** owns a pull request after it exists, including pull requests created outside Helix:

```text
PR event → inspect head SHA and CI/reviews → review or fix → report → merge decision
```

The PR-control module has its own trigger, state, policy, and agent workflow. It consumes PR open/update events, CI or review changes, and explicit PR comment commands. It may review, run verification, post checks/comments, request changes, or—when authorized—push fixes to the existing PR branch. It merges only when its policy and human-approval requirements allow it. Review-only or policy runs do not create another PR.

Keep this boundary logically independent even if both modules initially live in this repository and reuse Pi runtime adapters, specialist-session construction, event streaming, SQLite patterns, and policy interfaces. The PR work item must carry repository, PR number, base branch, head branch, head SHA, author, trigger, and idempotent external event ID as first-class data. Ignore self-authored bot events and deduplicate by repository + PR + head SHA + event identity to prevent feedback loops.

The current `DefaultDeliverablePipeline` is therefore provisional: it combines PR creation, merge-gate evaluation, approval, and optional immediate merge. Until the independent PR-control path exists, `deliverable.pr` remains opt-in and direct auto-merge is a demo capability rather than the target ownership model.

### What Pi owns and what Helix owns

| Pi harness | Helix host/control plane |
|---|---|
| Provider/model loop and tool continuation | Product modes, routing, workflow, gates, approvals |
| Transcript, session mechanics, compaction | Thread/run index, channel and identity mapping |
| Tool execution and runtime events | Tool policy, confirmations, credentials, sandbox boundary |
| Skills, extensions, prompts, resource loading | Curated memory, schedules, durable jobs, browser streaming |

For conversational agents, prefer Pi's session transcript as the canonical conversation record and SQLite as the control-plane index. Do not create a competing transcript schema unless multi-process durability or querying requirements justify it. Curated long-term memory is separate from both raw transcript and run history.

---

## Landscape notes (what we considered)

Studied for fit with Helix; not an adoption list.

| Option | Layer | Role vs Helix |
|---|---|---|
| Bare OpenAI SDK (`openai`) | API client | Too thin; multi-provider DIY |
| **Vercel AI SDK** | Open-source, provider-oriented agent toolkit | Capable standalone library, but its docs and ecosystem pull toward React/Next.js and Vercel services; study or adapt only for a concrete advantage |
| OpenAI Agents SDK | OpenAI-default, provider-extensible agent framework | Handoffs/guardrails/tracing; custom model providers exist, but OpenAI remains the default path — study, not default core |
| **pi** | Independent agent harness: provider layer, generic agent core, and complete coding-agent session host | Default substrate for coding and general-purpose profiles; override coding defaults rather than rebuilding the harness |
| Eve | Durable agent *product* framework (on AI SDK) | Strong patterns; **platform gravity** — study / optional deploy target, not Helix core |
| Google ADK | Open-source multi-agent orchestration framework | Local use is possible, but tutorials and adjacent services strongly favor Google Cloud/Vertex topology — study architecture, don't make it Helix's app shape |
| Temporal (and lighter job runners) | Durable execution | Natural map to explicit engine steps, idempotent effects, and HITL signals — **later adapter**, not a wrapper around today's `startRun` promise |
| OpenTelemetry | Vendor-neutral telemetry | Export path for high-level Helix lifecycle spans plus runtime-native model/tool spans — **later**; not the run-state source of truth |

**Platform gravity:** legal or technical portability is not enough. Documentation, examples, UI assumptions, managed state, evaluation, observability, and deployment guidance can still pull an application toward a vendor topology. Vercel or Google may host *capacity* later, but their control planes must not become the source of truth for Helix policy, identity, sessions, or workflow.

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
- Pi already supplies the complete local session harness needed to prototype a general conversation mode without introducing another agent SDK

Gaps vs this strategy (intentional for exploration):

- `RunContext`, the default orchestrator, and Manage still depend on `PiProvider`; runtime portability is aspirational
- `startRun` is one in-process promise; SQLite records are durable state, not replay-safe workflow checkpoints
- No resume after process death, stable effect/invocation IDs, or idempotency contract
- `RunEvent` has no schema version, sequence/event ID, or causation metadata yet
- No domain-event/observability port beyond the event stream and SQLite store
- No unified tool registry/policy boundary for native and future MCP tools
- The public product model is still `Issue → orchestrator → specialists → deliverable`; there is no persistent thread/message surface yet
- Session construction hard-codes coding tools and run-scoped in-memory sessions; general profiles need coding tools disabled by default and Pi-backed thread persistence

---

## Explicit non-goals (for this direction)

- Becoming an Eve app or ADK app as the default shape of Helix
- Adding a second production agent runtime without a measured Pi limitation and regression evidence
- Treating every assistant message as a multi-agent workflow
- Reimplementing Pi transcripts, compaction, resource loading, or the model/tool loop inside Helix
- OTel-first or Temporal-first rewrites before domain events/steps are stable
- Owning a forever home-grown distributed workflow engine once pain justifies an open standard
