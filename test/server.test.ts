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

test("GET / serves the React UI and its static assets", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "ok" }];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  const page = await request(app).get("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>Helix<\/title>/);
  assert.match(page.text, /id="root"/);

  const favicon = await request(app).get("/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.match(String(favicon.headers["content-type"]), /image\/svg\+xml/);

  await request(app).get("/legacy").expect(404);
  await request(app).get("/react").expect(404);
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
  assert.equal(got.body.checkpoint.phase, "delivery");
  assert.equal(got.body.checkpoint.delivery.status, "completed");
  assert.ok(got.body.events.some((event: { type: string }) => event.type === "delivery_started"));
});

test("server marks stale runs interrupted and resumes the same run id", async () => {
  const store = new MemoryRunStore();
  store.save({
    id: "resume-me",
    issue: { source: "inline", title: "Recover", body: "", labels: [] },
    startedAt: 100,
    status: "running",
    events: [{ ts: 100, type: "run_started", summary: "started" }],
    results: [],
    knowledge: [],
    checkpoint: { phase: "orchestrator", iteration: 0, updatedAt: 101 },
  });
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "recovered" }]),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  const app = createApp({ ctx });

  const interrupted = await request(app).get("/runs/resume-me");
  assert.equal(interrupted.status, 200);
  assert.equal(interrupted.body.status, "interrupted");
  assert.equal(interrupted.body.events.at(-1).type, "run_interrupted");

  const accepted = await request(app).post("/runs/resume-me/resume");
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.id, "resume-me");

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  const completed = await request(app).get("/runs/resume-me");
  assert.equal(completed.body.status, "done");
  assert.equal(completed.body.id, "resume-me");
  assert.ok(completed.body.events.some((event: { type: string }) => event.type === "run_resumed"));
});

test("interrupted active specialist requires an explicit retry confirmation", async () => {
  const store = new MemoryRunStore();
  store.save({
    id: "uncertain-specialist",
    issue: { source: "inline", title: "Recover uncertain work", body: "", labels: [] },
    startedAt: 100,
    status: "running",
    events: [],
    results: [],
    knowledge: [],
    checkpoint: {
      version: 1,
      phase: "specialists",
      iteration: 0,
      updatedAt: 101,
      invocations: [{ id: "invocation-1", specialist: "dev", task: "write files", status: "started" }],
    },
  });
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "recovered" }]),
    createSpecialistFactory: () => new StubSpecialistFactory([def("dev")], { dev: "already safe" }),
  });
  const app = createApp({ ctx });

  assert.equal(store.load("uncertain-specialist")?.checkpoint?.invocations?.[0].status, "uncertain");
  const refused = await request(app).post("/runs/uncertain-specialist/resume").send({});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.requiresRetryConfirmation, true);

  const accepted = await request(app)
    .post("/runs/uncertain-specialist/resume")
    .send({ retryUncertain: true });
  assert.equal(accepted.status, 202);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  const completed = store.load("uncertain-specialist");
  assert.equal(completed?.status, "done");
  assert.equal(completed?.results.length, 1);
  assert.ok(completed?.events.some((event) => event.type === "run_retry_confirmed"));
});

test("interrupted deliverable finalization resumes without rerunning orchestration", async () => {
  const store = new MemoryRunStore();
  let orchestratorCalls = 0;
  let deliveryCalls = 0;
  store.save({
    id: "uncertain-delivery",
    issue: { source: "inline", title: "Finish delivery", body: "", labels: [] },
    startedAt: 100,
    status: "delivering",
    events: [],
    results: [],
    knowledge: [],
    finalDecision: { kind: "done", reason: "implementation complete", deliverable: "demo" },
    checkpoint: {
      version: 1,
      phase: "delivery",
      iteration: 1,
      updatedAt: 101,
      delivery: { status: "started", attempt: 1 },
    },
  });
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: {
      async finalize(run) {
        deliveryCalls++;
        run.approvalStatus = "none";
        return run;
      },
    },
    createOrchestrator: () => ({
      async decide() {
        orchestratorCalls++;
        return { kind: "done" as const, reason: "must not run" };
      },
    }),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  const app = createApp({ ctx });

  const refused = await request(app).post("/runs/uncertain-delivery/resume").send({});
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.uncertain, ["deliverable finalization"]);
  await request(app)
    .post("/runs/uncertain-delivery/resume")
    .send({ retryUncertain: true })
    .expect(202);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

  const completed = store.load("uncertain-delivery");
  assert.equal(completed?.status, "done");
  assert.equal(completed?.checkpoint?.delivery?.status, "completed");
  assert.equal(deliveryCalls, 1);
  assert.equal(orchestratorCalls, 0);
});

test("pause endpoint parks at a boundary and resume completes the same run", async () => {
  const store = new MemoryRunStore();
  let orchestratorCount = 0;
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => {
      orchestratorCount++;
      if (orchestratorCount === 1) {
        return {
          async decide() {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
            return { kind: "run" as const, specialists: [{ specialist: "dev", task: "work" }], reason: "go" };
          },
        };
      }
      return new ScriptedOrchestrator([{ kind: "done", reason: "complete" }]);
    },
    createSpecialistFactory: () => new StubSpecialistFactory([def("dev")], { dev: "done" }),
  });
  const app = createApp({ ctx });
  const started = await request(app).post("/runs").send({ title: "Pause me" });
  const id = started.body.id as string;

  const pause = await request(app).post(`/runs/${id}/pause`);
  assert.equal(pause.status, 202);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
  assert.equal(store.load(id)?.status, "paused");
  assert.equal(store.load(id)?.checkpoint?.phase, "specialists");

  const resume = await request(app).post(`/runs/${id}/resume`);
  assert.equal(resume.status, 202);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  assert.equal(store.load(id)?.status, "done");
  assert.equal(store.load(id)?.results.length, 1);
});

test("graceful shutdown requests pause and drains a run to a safe boundary", async () => {
  const store = new MemoryRunStore();
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => ({
      async decide() {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        return { kind: "run" as const, specialists: [{ specialist: "dev", task: "work" }], reason: "go" };
      },
    }),
    createSpecialistFactory: () => new StubSpecialistFactory([def("dev")], { dev: "done" }),
  });
  const app = createApp({ ctx });
  const started = await request(app).post("/runs").send({ title: "Drain me" });
  const pauseActiveRuns = app.locals.pauseActiveRuns as (
    reason?: string,
    timeoutMs?: number,
  ) => Promise<{ requested: number; remaining: number }>;

  const result = await pauseActiveRuns("test shutdown", 500);
  assert.deepEqual(result, { requested: 1, remaining: 0 });
  assert.equal(store.load(started.body.id)?.status, "paused");
  assert.match(store.load(started.body.id)?.events.at(-1)?.summary ?? "", /test shutdown/);
});

test("POST /runs/:id/continuations starts a linked fresh run and deduplicates events", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "continued", deliverable: "ok" }];
  const { ctx, store } = testCtx(script);
  store.save({
    id: "root-run",
    issue: { source: "inline", title: "Original issue", body: "Original acceptance criteria", labels: ["bug"] },
    startedAt: 100,
    finishedAt: 200,
    status: "done",
    events: [],
    results: [],
    finalDecision: { kind: "done", reason: "initial work complete", deliverable: "first result" },
  });
  store.save({
    id: "parent-run",
    rootRunId: "root-run",
    parentRunId: "root-run",
    continuation: { instruction: "first follow-up", externalEventId: "comment:1", trigger: "issue.comment" },
    issue: { source: "inline", title: "Original issue", body: "prior continuation", labels: ["bug"] },
    startedAt: 300,
    finishedAt: 400,
    status: "done",
    events: [],
    results: [],
    finalDecision: { kind: "done", reason: "parent complete", deliverable: "parent result" },
  });

  const app = createApp({ ctx });
  const started = await request(app).post("/runs/parent-run/continuations").send({
    instruction: "Also cover the regression case",
    externalEventId: "comment:2",
    trigger: "issue.comment",
    pullRequestId: 44,
    pullRequestHeadBranch: "helix/issue-1-fix",
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.parentRunId, "parent-run");
  assert.equal(started.body.rootRunId, "root-run");

  await new Promise((r) => setTimeout(r, 100));
  const child = store.load(started.body.id as string);
  assert.equal(child?.status, "done");
  assert.equal(child?.parentRunId, "parent-run");
  assert.equal(child?.rootRunId, "root-run");
  assert.deepEqual(child?.continuation, {
    instruction: "Also cover the regression case",
    externalEventId: "comment:2",
    trigger: "issue.comment",
    pullRequestId: 44,
    pullRequestHeadBranch: "helix/issue-1-fix",
  });
  assert.match(child?.issue.body ?? "", /Original acceptance criteria/);
  assert.match(child?.issue.body ?? "", /parent result/);

  const duplicate = await request(app).post("/runs/parent-run/continuations").send({
    instruction: "This retry body is ignored",
    externalEventId: "comment:2",
    trigger: "issue.comment",
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.id, started.body.id);
  assert.equal(duplicate.body.duplicate, true);
});

test("continuations require a terminal parent and allow only one active child", async () => {
  const store = new MemoryRunStore();
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => ({
      async decide() {
        await new Promise((r) => setTimeout(r, 250));
        return { kind: "done" as const, reason: "eventually" };
      },
    }),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  store.save({
    id: "running-parent",
    issue: { source: "inline", title: "Busy", body: "", labels: [] },
    startedAt: 1,
    status: "running",
    events: [],
    results: [],
  });
  store.save({
    id: "done-parent",
    issue: { source: "inline", title: "Ready", body: "", labels: [] },
    startedAt: 1,
    finishedAt: 2,
    status: "done",
    events: [],
    results: [],
  });

  const app = createApp({ ctx });
  const nonterminal = await request(app).post("/runs/running-parent/continuations").send({
    instruction: "try",
    externalEventId: "reopen:1",
    trigger: "issue.reopened",
  });
  assert.equal(nonterminal.status, 409);

  const first = await request(app).post("/runs/done-parent/continuations").send({
    instruction: "first",
    externalEventId: "comment:10",
    trigger: "issue.comment",
  });
  assert.equal(first.status, 202);
  const second = await request(app).post("/runs/done-parent/continuations").send({
    instruction: "second",
    externalEventId: "comment:11",
    trigger: "issue.comment",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.id, first.body.id);

  await new Promise((r) => setTimeout(r, 300));
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

test("live response deltas use named SSE events", async () => {
  const store = new MemoryRunStore();
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => ({
      async decide(_input, opts) {
        opts?.onTextDelta?.('{"kind":"done"}');
        // Emitted immediately: verifies the host subscribes before startRun.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        return { kind: "done" as const, reason: "streamed" };
      },
    }),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  const app = createApp({ ctx });

  const start = await request(app).post("/runs").send({ title: "Named SSE" });
  const events = await request(app).get(`/runs/${start.body.id}/events`);

  assert.equal(events.status, 200);
  assert.match(events.text, /event: live/);
  assert.match(events.text, /orchestrator_output_delta/);
  assert.match(events.text, /\\\"kind\\\":\\\"done\\\"/);
  assert.match(events.text, /run_done/);
});

test("GET /runs lists persisted runs newest first", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "listed", deliverable: "x" }];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  await request(app).post("/runs").send({ title: "First", body: "one" });
  await new Promise((r) => setTimeout(r, 15));
  await request(app).post("/runs").send({ title: "Second", body: "two" });
  await new Promise((r) => setTimeout(r, 120));

  const list = await request(app).get("/runs");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].title, "Second");
});

test("DELETE /runs/:id removes a finished run", async () => {
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "bye", deliverable: "x" }];
  const { ctx } = testCtx(script);
  const app = createApp({ ctx });

  const start = await request(app).post("/runs").send({ title: "Disposable" });
  const id = start.body.id as string;
  await new Promise((r) => setTimeout(r, 120));

  const del = await request(app).delete(`/runs/${id}`);
  assert.equal(del.status, 204);
  assert.equal(ctx.store.load(id), undefined);

  const list = await request(app).get("/runs");
  assert.equal(list.body.find((r: { id: string }) => r.id === id), undefined);

  const missing = await request(app).delete(`/runs/${id}`);
  assert.equal(missing.status, 404);
});

test("DELETE /runs/:id rejects while run is still active", async () => {
  const store = new MemoryRunStore();
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    deliverable: new NoOpDeliverablePipeline(),
    provider: new FakeProvider(),
    createOrchestrator: () => ({
      async decide() {
        await new Promise((r) => setTimeout(r, 300));
        return { kind: "done" as const, reason: "ok", deliverable: "x" };
      },
    }),
    createSpecialistFactory: () =>
      new StubSpecialistFactory(loadSpecialists(resolve(fixtureDir, "agents")), { planner: "p", dev: "d", verifier: "ok" }),
  });
  const app = createApp({ ctx });

  const start = await request(app).post("/runs").send({ title: "Still running" });
  const id = start.body.id as string;

  const del = await request(app).delete(`/runs/${id}`);
  assert.equal(del.status, 409);

  await new Promise((r) => setTimeout(r, 400));
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
