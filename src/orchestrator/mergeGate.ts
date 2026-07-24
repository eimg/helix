/**
 * Merge gate execution — deterministic thresholds applied after a successful run.
 * Pure evaluation; side effects (PR create/merge) live in the deliverable pipeline.
 */
import type { MergeGateConfig } from "./workflow.js";
export interface DiffStats {
  lines: number;
  files: number;
}

export type MergeGateAction = "auto-merge" | "pending-approval";

export interface MergeGateResult {
  action: MergeGateAction;
  reason: string;
  diffLines: number;
  diffFiles: number;
}

export function evaluateMergeGate(input: {
  stats: DiffStats;
  config: MergeGateConfig;
}): MergeGateResult {
  const { stats, config } = input;

  if (stats.lines > config.maxDiffLines) {
    return {
      action: "pending-approval",
      reason: `Diff too large (${stats.lines} lines > ${config.maxDiffLines}).`,
      diffLines: stats.lines,
      diffFiles: stats.files,
    };
  }

  if (stats.files > config.maxFiles) {
    return {
      action: "pending-approval",
      reason: `Too many files changed (${stats.files} > ${config.maxFiles}).`,
      diffLines: stats.lines,
      diffFiles: stats.files,
    };
  }

  if (config.autoMerge) {
    return {
      action: "auto-merge",
      reason: "Within merge gate thresholds.",
      diffLines: stats.lines,
      diffFiles: stats.files,
    };
  }

  return {
    action: "pending-approval",
    reason: "Within thresholds but autoMerge is disabled.",
    diffLines: stats.lines,
    diffFiles: stats.files,
  };
}
