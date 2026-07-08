import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import type { OrchestratorDecision, SpecialistDefinition } from "../src/engine/types.js";
import { loadConfig } from "../src/config.js";
import { loadWorkflow } from "../src/orchestrator/workflow.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { FakePullRequestCreator } from "../src/deliverable/pr.js";

const fixtureDir = resolve("examples/ts/.helix");

function def(name: string): SpecialistDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `You are ${name}.`,
    filePath: `/fake/${name}.md`,
    source: "project",
  };
}

function testCtx(script: OrchestratorDecision[]) {
  const store = new MemoryRunStore();
  const config = loadConfig(fixtureDir);
  const workflow = loadWorkflow(config);
  const specialists = loadSpecialists(resolve(fixtureDir, "agents"));
  const factory = new StubSpecialistFactory(specialists.length ? specialists : [def("dev")], { dev: "done" });

  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator(script),
    createSpecialistFactory: () => factory,
  });

  return { ctx, store };
}

test("GET / serves web UI", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "ok" }];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  const page = await request(app).get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Helix<\/title>/);
  assert.match(page.text, /id="run-form"/);

  const css = await request(app).get("/app.css");
  assert.equal(css.status, 200);

  const js = await request(app).get("/app.js");
  assert.equal(js.status, 200);
  assert.match(js.text, /streamRun/);
});

test("POST /runs starts inline run and GET returns final state", async () => {
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "dev", task: "go" }], reason: "start" },
    { kind: "done", reason: "finished", deliverable: "ok" },
  ];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  const start = await request(app).post("/runs").send({ title: "Test", body: "Do it" });
  assert.equal(start.status, 202);
  const id = start.body.id as string;
  assert.ok(id);

  // wait for background run
  await new Promise((r) => setTimeout(r, 100));

  const got = await request(app).get(`/runs/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, "done");
  assert.equal(got.body.issue.title, "Test");
});

test("GET /runs/:id/events returns SSE payload", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "quick", deliverable: "x" }];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  const start = await request(app).post("/runs").send({ title: "SSE test" });
  const id = start.body.id as string;
  await new Promise((r) => setTimeout(r, 80));

  const events = await request(app).get(`/runs/${id}/events`);
  assert.equal(events.status, 200);
  assert.match(events.text, /run_started/);
  assert.match(events.text, /run_done/);
});

test("approve and reject pending runs", async () => {
  const store = new MemoryRunStore();
  const pr = new FakePullRequestCreator();
  const ctx = createRunContext({ helixDir: fixtureDir, store, deliverable: new NoOpDeliverablePipeline() });

  store.save({
    id: "pending-1",
    issue: { source: "inline", title: "t", body: "", labels: [] },
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "done",
    events: [],
    results: [],
    approvalStatus: "pending",
    pullRequest: { url: "https://github.com/a/b/pull/9", number: 9, branch: "feat", draft: true },
  });

  const app = createApp({ ctx, pr });
  const approved = await request(app).post("/runs/pending-1/approve");
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approvalStatus, "approved");
  assert.deepEqual(pr.merged, [9]);

  store.save({
    id: "pending-2",
    issue: { source: "inline", title: "t", body: "", labels: [] },
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "done",
    events: [],
    results: [],
    approvalStatus: "pending",
    pullRequest: { url: "https://github.com/a/b/pull/10", number: 10, branch: "feat", draft: true },
  });
  const rej = await request(app).post("/runs/pending-2/reject");
  assert.equal(rej.status, 200);
  assert.equal(rej.body.approvalStatus, "rejected");
});
