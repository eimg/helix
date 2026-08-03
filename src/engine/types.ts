/**
 * Core Helix types.
 *
 * The engine is designed around a few small interfaces so that a full run can
 * be driven with fakes (fake provider, stub specialist) without touching the
 * network — see test/m1-happy-path.test.ts.
 */

/** Link back to an external issue tracker for completion callbacks. */
export interface IssueExternalRef {
  trackerUrl: string;
  issueId: number;
}

/** A work item that triggers a run. */
export interface Issue {
  /** Origin of the issue — "github" (fetched) or "inline" (passed directly). */
  source: "github" | "inline";
  title: string;
  body: string;
  labels: string[];
  /** GitHub-specific. Present iff source === "github". */
  repo?: string;
  number?: number;
  url?: string;
  /** External tracker correlation for completion webhooks. */
  external?: IssueExternalRef;
}

/**
 * Fetches a work item by an opaque identifier (a GitHub issue number for v1).
 * Automated triggers (M2 poll/webhook) implement this; the inline/terminal
 * path bypasses it and constructs an `Issue` directly — proving trigger and
 * orchestrator are independent.
 */
export interface Trigger {
  readonly source: "github";
  fetchIssue(number: number): Promise<Issue>;
}

/** A specialist agent definition, loaded from `.helix/agents/*.md`. */
export interface SpecialistDefinition {
  name: string;
  description: string;
  model?: string; // provider/id, e.g. "openrouter/anthropic/claude-sonnet-4"
  tools?: string[]; // built-in tool names to enable; undefined = pi defaults
  systemPrompt: string;
  filePath: string;
  source: "project";
}

/** One line in a specialist's live activity log (tool call, assistant text, etc.). */
export interface SpecialistActivityLine {
  kind: "tool" | "text_delta";
  line: string;
  toolName?: string;
  phase?: "start" | "end";
  isError?: boolean;
}

export interface SpecialistRunOptions {
  onActivity?: (line: SpecialistActivityLine) => void;
}

/** The result of running a specialist on a task. */
export interface SpecialistResult {
  /** Stable within one run so an interrupted invocation can be correlated on resume. */
  invocationId?: string;
  specialist: string;
  task: string;
  ok: boolean;
  /** Final assistant text, or error message. */
  output: string;
  usage?: { input: number; output: number; cost: number; turns: number };
  error?: string;
}

/** Compact, runtime-neutral handoff shared between otherwise isolated specialists. */
export interface RunKnowledgeEntry {
  specialist: string;
  ok: boolean;
  summary: string;
  relevantPaths: string[];
  verifiedCommands: string[];
}

/** What the orchestrator asks the engine to do next. */
export type OrchestratorDecision =
  | { kind: "run"; specialists: SpecialistCall[]; reason: string }
  | { kind: "done"; reason: string; deliverable?: string }
  | { kind: "escalate"; reason: string };

/** One specialist invocation requested by the orchestrator. */
export interface SpecialistCall {
  specialist: string;
  task: string;
}

/** A single structured event in a run's lifecycle. */
export interface RunEvent {
  ts: number;
  type:
    | "run_started"
    | "issue_fetched"
    | "orchestrator_started"
    | "orchestrator_output_delta"
    | "orchestrator_finished"
    | "orchestrator_decided"
    | "specialist_started"
    | "specialist_activity"
    | "specialist_output_delta"
    | "specialist_finished"
    | "run_pause_requested"
    | "run_paused"
    | "run_resumed"
    | "run_interrupted"
    | "run_retry_confirmed"
    | "delivery_pending"
    | "delivery_started"
    | "delivery_finished"
    | "gate_blocked"
    | "run_done"
    | "run_escalated"
    | "run_error";
  summary: string;
  details?: Record<string, unknown>;
}

export interface RunSteeringDecision {
  decisionId: string;
  caseId: string;
  actionKey: string;
  resolution: "approve" | "reject" | "request_revision" | "defer" | "escalate" | "cancel";
  rationale: string;
  decidedAt: string;
  actor: { id: string; issuer: string; username: string; displayName: string; kind: "human" | "service" | "development" };
  resource: { type: string; id: string; expectedRevision: string };
  receiptStatus: "recorded" | "stale";
  /** Added after the initial decision-ledger slice; absent legacy records are observation-only. */
  workflowEffect?: "awaiting_recovery" | "holding" | "observation_only" | "recovery_accepted";
  sourceRevision: string;
  receivedAt: string;
}

/** A full run record, persisted by the configured RunStore. */
export type ApprovalStatus = "none" | "pending" | "approved" | "rejected";

export interface MergeGateResult {
  action: "auto-merge" | "pending-approval";
  reason: string;
  diffLines: number;
  diffFiles: number;
}

export interface PullRequestInfo {
  url: string;
  number: number;
  branch: string;
  draft: boolean;
}

export interface Run {
  id: string;
  /** Human dispositions received from Steering; audit-only until this workflow defines a deterministic response. */
  steeringDecisions?: RunSteeringDecision[];
  /** Linked-run lineage. Absent for an initial run. */
  parentRunId?: string;
  /** First run in this issue lineage. Set on continuation runs. */
  rootRunId?: string;
  /** External event that requested this continuation. */
  continuation?: RunContinuation;
  issue: Issue;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "pause_requested" | "paused" | "interrupted" | "delivering" | "done" | "escalated" | "error";
  events: RunEvent[];
  results: SpecialistResult[];
  /** Compact cross-specialist handoffs; raw Pi conversations remain session-owned. */
  knowledge?: RunKnowledgeEntry[];
  /** Last replay-safe orchestration boundary. High-volume model deltas remain live-only. */
  checkpoint?: RunCheckpoint;
  finalDecision?: OrchestratorDecision;
  runFile?: string;
  /** Human approval gate (M2). */
  approvalStatus?: ApprovalStatus;
  mergeGateResult?: MergeGateResult;
  pullRequest?: PullRequestInfo;
  deliverableError?: string;
  /** Retained only when a Helix-managed implementation worktree needs inspection. */
  implementationWorkspace?: {
    path: string;
    branch: string;
    repositoryPath?: string;
    baseBranch?: string;
    baseSha?: string;
  };
}

export interface RunCheckpoint {
  /** Optional on imported first-pass records; new checkpoints always write version 1. */
  version?: 1;
  phase: "orchestrator" | "specialists" | "delivery";
  /** 0-based orchestrator turn that owns this checkpoint. */
  iteration: number;
  updatedAt: number;
  /** Present while executing a persisted orchestrator `run` decision. */
  decision?: Extract<OrchestratorDecision, { kind: "run" }>;
  invocations?: RunCheckpointInvocation[];
  delivery?: {
    status: "pending" | "started" | "uncertain" | "completed";
    attempt: number;
  };
}

export interface RunCheckpointInvocation {
  id: string;
  specialist: string;
  task: string;
  status: "pending" | "started" | "uncertain" | "completed";
}

export interface RunContinuation {
  instruction: string;
  externalEventId: string;
  trigger: string;
  /** Prefer updating this Acme Issues PR instead of opening a new one. */
  pullRequestId?: number;
  /** Prefer continuing on this head branch when it still exists locally. */
  pullRequestHeadBranch?: string;
}

/** LLM provider abstraction. v1: OpenRouter. Tests: FakeProvider. */
export interface Provider {
  name: string;
  /** Resolve a model id from config into a pi Model object. */
  resolveModel(modelId: string): Promise<unknown>;
}

/** A factory that creates an isolated specialist session. */
export interface SpecialistSessionFactory {
  create(def: SpecialistDefinition): Promise<SpecialistSession>;
}

/** An isolated specialist agent session. */
export interface SpecialistSession {
  readonly name: string;
  run(task: string, opts?: SpecialistRunOptions): Promise<SpecialistResult>;
  dispose(): void;
}

/** Hybrid orchestrator: given issue + state, decide next. */
export interface Orchestrator {
  decide(input: OrchestratorInput, opts?: OrchestratorRunOptions): Promise<OrchestratorDecision>;
}

export interface OrchestratorRunOptions {
  /** Streams only visible assistant response text, never hidden reasoning. */
  onTextDelta?: (delta: string) => void;
}

export interface OrchestratorInput {
  issue: Issue;
  specialists: SpecialistDefinition[];
  results: SpecialistResult[];
  /** 0-based iteration counter for loop-limit enforcement. */
  iteration: number;
  /**
   * Deterministic repo bootstrap (tree, manifests, allowlisted docs).
   * Shown to the orchestrator initially and injected into every cold specialist session.
   */
  repoContext?: string;
}
