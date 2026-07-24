import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMergeGate } from "../src/orchestrator/mergeGate.js";
import type { MergeGateConfig } from "../src/orchestrator/workflow.js";

const base: MergeGateConfig = {
  autoMerge: true,
  maxDiffLines: 300,
  maxFiles: 10,
  else: "draft-pr-and-notify",
};

test("evaluateMergeGate: auto-merge when the diff is within thresholds", () => {
  const r = evaluateMergeGate({
    stats: { lines: 50, files: 3 },
    config: base,
  });
  assert.equal(r.action, "auto-merge");
  assert.equal(r.reason, "Within merge gate thresholds.");
});

test("evaluateMergeGate: pending when diff too large", () => {
  const r = evaluateMergeGate({
    stats: { lines: 500, files: 3 },
    config: base,
  });
  assert.equal(r.action, "pending-approval");
});

test("evaluateMergeGate: pending when too many files", () => {
  const r = evaluateMergeGate({
    stats: { lines: 50, files: 20 },
    config: base,
  });
  assert.equal(r.action, "pending-approval");
});

test("evaluateMergeGate: pending when auto-merge is disabled", () => {
  const r = evaluateMergeGate({
    stats: { lines: 50, files: 3 },
    config: { ...base, autoMerge: false },
  });
  assert.equal(r.action, "pending-approval");
});
