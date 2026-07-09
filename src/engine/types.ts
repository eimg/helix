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

/** The result of running a specialist on a task. */
export interface SpecialistResult {
  specialist: string;
  task: string;
  ok: boolean;
  /** Final assistant text, or error message. */
  output: string;
  usage?: { input: number; output: number; cost: number; turns: number };
  error?: string;
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
    | "orchestrator_decided"
    | "specialist_started"
    | "specialist_finished"
    | "gate_blocked"
    | "run_done"
    | "run_escalated"
    | "run_error";
  summary: string;
  details?: Record<string, unknown>;
}

/** A full run record, persisted to `.helix/runs/<run-id>.json`. */
export type ApprovalStatus = "none" | "pending" | "approved" | "rejected";

export interface MergeGateResult {
  action: "auto-merge" | "pending-approval" | "blocked";
  reason: string;
  diffLines: number;
  diffFiles: number;
  verifierPassed: boolean;
}

export interface PullRequestInfo {
  url: string;
  number: number;
  branch: string;
  draft: boolean;
}

export interface Run {
  id: string;
  issue: Issue;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "done" | "escalated" | "error";
  events: RunEvent[];
  results: SpecialistResult[];
  finalDecision?: OrchestratorDecision;
  runFile?: string;
  /** Human approval gate (M2). */
  approvalStatus?: ApprovalStatus;
  mergeGateResult?: MergeGateResult;
  pullRequest?: PullRequestInfo;
  deliverableError?: string;
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
  run(task: string): Promise<SpecialistResult>;
  dispose(): void;
}

/** Hybrid orchestrator: given issue + state, decide next. */
export interface Orchestrator {
  decide(input: OrchestratorInput): Promise<OrchestratorDecision>;
}

export interface OrchestratorInput {
  issue: Issue;
  specialists: SpecialistDefinition[];
  results: SpecialistResult[];
  /** 0-based iteration counter for loop-limit enforcement. */
  iteration: number;
  /**
   * Deterministic repo bootstrap (tree, manifests, allowlisted docs).
   * Injected by the engine on the first specialist wave; also shown to the orchestrator.
   */
  repoContext?: string;
}
