/**
 * Merge gate execution — deterministic thresholds applied after a successful run.
 * Pure evaluation; side effects (PR create/merge) live in the deliverable pipeline.
 */
import type { MergeGateConfig } from "./workflow.js";
import type { SpecialistResult } from "../engine/types.js";

export interface DiffStats {
  lines: number;
  files: number;
}

export type MergeGateAction = "auto-merge" | "pending-approval" | "blocked";

export interface MergeGateResult {
  action: MergeGateAction;
  reason: string;
  diffLines: number;
  diffFiles: number;
  verifierPassed: boolean;
}

export function verifierPassed(results: SpecialistResult[], requireVerifierPass: boolean): boolean {
  if (!requireVerifierPass) return true;
  return results.some((r) => r.specialist === "verifier" && r.ok);
}

export function evaluateMergeGate(input: {
  stats: DiffStats;
  results: SpecialistResult[];
  config: MergeGateConfig;
}): MergeGateResult {
  const { stats, results, config } = input;
  const vPass = verifierPassed(results, config.requireVerifierPass);

  if (!vPass) {
    return {
      action: "blocked",
      reason: "Verifier did not pass (requireVerifierPass is true).",
      diffLines: stats.lines,
      diffFiles: stats.files,
      verifierPassed: false,
    };
  }

  if (stats.lines > config.maxDiffLines) {
    return {
      action: "pending-approval",
      reason: `Diff too large (${stats.lines} lines > ${config.maxDiffLines}).`,
      diffLines: stats.lines,
      diffFiles: stats.files,
      verifierPassed: true,
    };
  }

  if (stats.files > config.maxFiles) {
    return {
      action: "pending-approval",
      reason: `Too many files changed (${stats.files} > ${config.maxFiles}).`,
      diffLines: stats.lines,
      diffFiles: stats.files,
      verifierPassed: true,
    };
  }

  if (config.autoMerge) {
    return {
      action: "auto-merge",
      reason: "Within merge gate thresholds and verifier passed.",
      diffLines: stats.lines,
      diffFiles: stats.files,
      verifierPassed: true,
    };
  }

  return {
    action: "pending-approval",
    reason: "Within thresholds but autoMerge is disabled.",
    diffLines: stats.lines,
    diffFiles: stats.files,
    verifierPassed: true,
  };
}
