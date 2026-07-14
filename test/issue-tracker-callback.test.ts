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
import type { OrchestratorDecision } from "../src/engine/types.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { notifyIssueTracker } from "../src/callbacks/issueTracker.js";

const fixtureDir = resolve("examples/ts/.helix");

test("notifyIssueTracker POSTs run.completed to tracker", async () => {
  const calls: { url: string; body: unknown; event: string }[] = [];
  await notifyIssueTracker(
    {
      id: "run-abc",
      issue: {
        source: "inline",
        title: "Fix login",
        body: "",
        labels: ["trigger"],
        external: { trackerUrl: "http://issues.test", issueId: 7 },
      },
      startedAt: 1000,
      finishedAt: 2000,
      status: "done",
      events: [],
      results: [],
    },
    {
      fetchFn: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          event: String(new Headers(init?.headers).get("X-Helix-Event")),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://issues.test/api/webhooks/helix");
  assert.equal(calls[0].event, "run.completed");
  assert.deepEqual(calls[0].body, {
    event: "run.completed",
    run: { id: "run-abc", status: "done", startedAt: 1000, finishedAt: 2000 },
    issue: { id: 7, title: "Fix login" },
  });
});

test("completed run triggers issue tracker callback", async () => {
  const callbackCalls: unknown[] = [];
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "ok", deliverable: "done" }];
  const store = new MemoryRunStore();
  const specialists = loadSpecialists(resolve(fixtureDir, "agents"));
  const factory = new StubSpecialistFactory(specialists, { dev: "done" });

  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator(script),
    createSpecialistFactory: () => factory,
    issueTrackerFetch: async (_url, init) => {
      callbackCalls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const app = createApp({ ctx });
  const start = await request(app)
    .post("/runs")
    .send({
      title: "Close me",
      external: { trackerUrl: "http://issues.test", issueId: 42 },
    });
  assert.equal(start.status, 202);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(callbackCalls.length, 1);
  assert.equal((callbackCalls[0] as { issue: { id: number } }).issue.id, 42);
});
