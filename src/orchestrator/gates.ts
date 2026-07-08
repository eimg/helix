/**
 * Deterministic safety gates the orchestrator is not allowed to override.
 * Pure functions, unit-tested in test/gates.test.ts.
 */
import type { OrchestratorDecision, SpecialistResult } from "../engine/types.js";

export interface GateConfig {
  maxIterations: number; // hard cap on orchestrator loop iterations
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  maxIterations: 6,
};

/** Returns a blocked decision if the orchestrator exceeded its iteration cap. */
export function enforceIterationCap(
  decision: OrchestratorDecision,
  iteration: number,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): OrchestratorDecision {
  if (decision.kind === "run" && iteration >= config.maxIterations) {
    return {
      kind: "escalate",
      reason: `Iteration cap reached (${config.maxIterations}). Last decision: ${decision.reason}`,
    };
  }
  return decision;
}

/** A specialist result is considered a failure that blocks "done". */
export function isBlockingFailure(results: SpecialistResult[]): boolean {
  return results.some((r) => !r.ok);
}
