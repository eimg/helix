import assert from "node:assert/strict";
import { it } from "node:test";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import type { Run } from "../src/engine/types.js";

it("accepts and deduplicates a Steering recovery action", async () => {
  const store = new MemoryRunStore();
  const interruptedAt = Date.now();
  const run: Run = {
    id: "run-steering-action",
    issue: { source: "inline", title: "Recover me", body: "", labels: [] },
    startedAt: interruptedAt - 1_000,
    status: "interrupted",
    events: [{ ts: interruptedAt, type: "run_interrupted", summary: "Interrupted" }],
    results: [],
    checkpoint: { version: 1, phase: "orchestrator", iteration: 0, updatedAt: interruptedAt },
  };
  store.save(run);
  const factory = new StubSpecialistFactory([], {});
  const ctx = createRunContext({
    helixDir: ".helix",
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "Recovered" }]),
    createSpecialistFactory: () => factory,
  });
  const app = createApp({ ctx });
  const decision = {
    schemaVersion: "acme.steering.decision.v1", decisionId: "decision-1", caseId: "case-1",
    actionKey: "helix.recover_run", resolution: "approve", rationale: "Recover from the durable checkpoint.",
    decidedAt: "2026-08-03T00:00:00.000Z",
    actor: { id: "identity:admin", issuer: "acme-identity", username: "admin", displayName: "Administrator", kind: "human" },
    resource: { type: "run", id: run.id, expectedRevision: String(interruptedAt) },
  };
  const revisionDecision = {
    ...decision,
    decisionId: "decision-revision-1",
    resolution: "request_revision",
    rationale: "Preserve the current checkpoint while the recovery approach is clarified.",
  };
  await request(app).post("/api/steering/decisions").send(revisionDecision).expect(202);
  assert.equal(store.load(run.id)?.steeringDecisions?.[0]?.workflowEffect, "holding");
  assert.equal(store.load(run.id)?.status, "interrupted");
  assert.equal(store.load(run.id)?.events.at(-1)?.ts, interruptedAt);
  await request(app).post("/api/steering/decisions").send(decision).expect(202).expect(({ body: receipt }) => {
    assert.equal(receipt.status, "recorded");
  });
  assert.equal(store.load(run.id)?.steeringDecisions?.[1]?.workflowEffect, "awaiting_recovery");
  await request(app).post("/api/steering/decisions").send(decision).expect(200).expect(({ body: receipt }) => {
    assert.equal(receipt.status, "already_recorded");
  });
  assert.equal(store.load(run.id)?.status, "interrupted");
  assert.equal(store.load(run.id)?.events.at(-1)?.ts, interruptedAt);
  const body = {
    schemaVersion: "acme.steering.action.v1", requestId: "req-1", caseId: "case-1", decisionId: "decision-1",
    actionKey: "helix.recover_run",
    resource: { type: "run", id: run.id, expectedRevision: String(interruptedAt) },
  };
  const accepted = await request(app).post("/api/steering/actions").send(body).expect(202);
  assert.equal(accepted.body.status, "accepted");
  assert.equal(store.load(run.id)?.steeringDecisions?.[1]?.workflowEffect, "recovery_accepted");
  const duplicate = await request(app).post("/api/steering/actions").send(body).expect(200);
  assert.equal(duplicate.body.status, "already_applied");
});
