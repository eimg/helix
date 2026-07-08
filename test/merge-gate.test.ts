import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMergeGate, verifierPassed } from "../src/orchestrator/mergeGate.js";
import type { MergeGateConfig } from "../src/orchestrator/workflow.js";

const base: MergeGateConfig = {
  autoMerge: true,
  maxDiffLines: 300,
  maxFiles: 10,
  requireVerifierPass: true,
  else: "draft-pr-and-notify",
};

test("evaluateMergeGate: auto-merge when small and verified", () => {
  const r = evaluateMergeGate({
    stats: { lines: 50, files: 3 },
    results: [{ specialist: "verifier", task: "t", ok: true, output: "ok" }],
    config: base,
  });
  assert.equal(r.action, "auto-merge");
});

test("evaluateMergeGate: blocked when verifier required but failed", () => {
  const r = evaluateMergeGate({
    stats: { lines: 10, files: 1 },
    results: [{ specialist: "verifier", task: "t", ok: false, output: "fail" }],
    config: base,
  });
  assert.equal(r.action, "blocked");
});

test("evaluateMergeGate: pending when diff too large", () => {
  const r = evaluateMergeGate({
    stats: { lines: 500, files: 3 },
    results: [{ specialist: "verifier", task: "t", ok: true, output: "ok" }],
    config: base,
  });
  assert.equal(r.action, "pending-approval");
});

test("evaluateMergeGate: pending when too many files", () => {
  const r = evaluateMergeGate({
    stats: { lines: 50, files: 20 },
    results: [{ specialist: "verifier", task: "t", ok: true, output: "ok" }],
    config: base,
  });
  assert.equal(r.action, "pending-approval");
});

test("verifierPassed: skips check when not required", () => {
  assert.equal(verifierPassed([], false), true);
});
