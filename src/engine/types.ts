/**
 * Core Helix types.
 *
 * The engine is designed around a few small interfaces so that a full run can
 * be driven with fakes (fake provider, stub specialist) without touching the
 * network — see test/m1-happy-path.test.ts.
 */

/** A fetched work item that triggers a run. v1 source: a GitHub issue. */
export interface Issue {
  source: "github";
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

/** Fetches a work item. v1: GitHub only (manual `gh` fetch); M2 adds polling. */
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
}

/** LLM provider abstraction. v1: OpenRouter. Tests: FakeProvider. */
export interface Provider {
  name: string;
  /** Resolve a model id from config into a pi Model object. */
  resolveModel(modelId: string): Promise<unknown>;
  /** API key / auth for pi's AuthStorage, or undefined to use defaults. */
  auth?: { provider: string; apiKey: string };
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
}
