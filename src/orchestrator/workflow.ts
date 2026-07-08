/**
 * Loads the configured workflow (specialist order), loop rules, and merge gate
 * from HelixConfig. The hybrid orchestrator uses this as *rails* the LLM
 * driver reasons within; deterministic code (gates.ts) enforces the hard parts.
 */
import type { HelixConfig } from "../config.js";

export interface Workflow {
  /** Specialist names in their default sequence. */
  steps: string[];
  /** Loop rules, e.g. { "verifier-fail": { backTo: "dev", maxRetries: 2 } }. */
  loops: Record<string, { backTo: string; maxRetries: number }>;
  /** Merge gate thresholds (evaluated in M2; logic only in M1). */
  mergeGate: MergeGateConfig;
  /** Hard iteration cap (mirrors gates.ts). */
  maxIterations: number;
}

export interface MergeGateConfig {
  autoMerge: boolean;
  maxDiffLines: number;
  maxFiles: number;
  requireVerifierPass: boolean;
  /** "auto-merge" | "draft-pr-and-notify" — only the former is acted on in M2. */
  else: string;
}

const DEFAULT_MERGE_GATE: MergeGateConfig = {
  autoMerge: true,
  maxDiffLines: 300,
  maxFiles: 10,
  requireVerifierPass: true,
  else: "draft-pr-and-notify",
};

export function loadWorkflow(config: HelixConfig): Workflow {
  const loops = (config.orchestrator as { loops?: Record<string, { backTo: string; maxRetries: number }> }).loops ?? {};
  return {
    steps: config.orchestrator.workflow,
    loops,
    mergeGate: { ...DEFAULT_MERGE_GATE, ...config.mergeGate },
    maxIterations: config.orchestrator.maxIterations ?? 6,
  };
}

/** Render the workflow as concise text for the orchestrator's system prompt. */
export function describeWorkflow(wf: Workflow): string {
  const lines = [`Default sequence: ${wf.steps.join(" → ")}`];
  for (const [trigger, rule] of Object.entries(wf.loops)) {
    lines.push(`On ${trigger}: go back to "${rule.backTo}", max ${rule.maxRetries} retries.`);
  }
  lines.push(`Hard iteration cap: ${wf.maxIterations}.`);
  return lines.join("\n");
}
