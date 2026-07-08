import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceIterationCap, isBlockingFailure, DEFAULT_GATE_CONFIG } from "../src/orchestrator/gates.js";
import type { OrchestratorDecision, SpecialistResult } from "../src/engine/types.js";

const runDecision: OrchestratorDecision = { kind: "run", specialists: [{ specialist: "dev", task: "x" }], reason: "go" };

test("enforceIterationCap: allows run under cap", () => {
  const d = enforceIterationCap(runDecision, 0, DEFAULT_GATE_CONFIG);
  assert.equal(d.kind, "run");
});

test("enforceIterationCap: escalates at/over cap", () => {
  const d = enforceIterationCap(runDecision, DEFAULT_GATE_CONFIG.maxIterations, DEFAULT_GATE_CONFIG);
  assert.equal(d.kind, "escalate");
  assert.match((d as { reason: string }).reason, /Iteration cap/);
});

test("enforceIterationCap: passes through done/escalate untouched", () => {
  const done: OrchestratorDecision = { kind: "done", reason: "ok" };
  assert.equal(enforceIterationCap(done, 999, DEFAULT_GATE_CONFIG).kind, "done");
  const esc: OrchestratorDecision = { kind: "escalate", reason: "nope" };
  assert.equal(enforceIterationCap(esc, 999, DEFAULT_GATE_CONFIG).kind, "escalate");
});

test("isBlockingFailure: detects failed results", () => {
  const ok: SpecialistResult = { specialist: "a", task: "t", ok: true, output: "" };
  const fail: SpecialistResult = { specialist: "b", task: "t", ok: false, output: "", error: "boom" };
  assert.equal(isBlockingFailure([ok]), false);
  assert.equal(isBlockingFailure([ok, fail]), true);
});
