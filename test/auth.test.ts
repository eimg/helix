import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import {
  HelixAuthError,
  createAcmeIdentityAuthAdapter,
  type HelixAuthAdapter,
  type HelixPrincipal,
} from "../src/server/auth.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";

const fixtureDir = resolve("examples/ts/.helix");

function appFor(principal: HelixPrincipal) {
  const adapter: HelixAuthAdapter = {
    provider: "test",
    async resolve() {
      return principal;
    },
  };
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "ok" }]),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  return createApp({ ctx, authAdapter: adapter });
}

function principal(permissions: string[]): HelixPrincipal {
  return {
    id: "user:1",
    issuer: "test",
    username: "test",
    displayName: "Test user",
    roles: ["test"],
    permissions,
    kind: "human",
  };
}

test("standalone auth stays backward compatible while health and pages remain public", async () => {
  const app = appFor(principal(["helix.read"]));
  await request(app).get("/").expect(200);
  await request(app).get("/health").expect(200);
  await request(app).get("/runs").expect(200);
});

test("Helix permissions separate reads, triggering, management, and history deletion", async () => {
  const viewer = appFor(principal(["helix.read"]));
  await request(viewer).get("/runs").expect(200);
  const triggerDenied = await request(viewer).post("/runs").send({ title: "No" });
  assert.equal(triggerDenied.status, 403);
  assert.equal(triggerDenied.body.error, "Missing permission: helix.trigger");
  await request(viewer).put("/manage/workflow").send({ steps: [] }).expect(403);
  await request(viewer).delete("/runs/missing").expect(403);

  const operator = appFor(principal(["helix.trigger", "helix.review", "helix.merge"]));
  await request(operator).get("/runs").expect(200);
  await request(operator).post("/runs").send({ title: "Allowed" }).expect(202);
  await request(operator).post("/pr-reviews").send({}).expect(501);
  await request(operator).post("/local-prs/merge").send({}).expect(400);
  await request(operator).post("/bootstrap").send({}).expect(403);
  await request(operator).post("/api/steering/actions").send({}).expect(403);

  const steering = appFor(principal(["helix.steering.recover"]));
  await request(steering).post("/api/steering/actions").send({}).expect(400);
  await request(steering).post("/runs").send({ title: "No broad trigger" }).expect(403);

  const admin = appFor(principal(["helix.admin"]));
  await request(admin).delete("/runs/missing").expect(404);
});

test("auth provider failures fail closed without affecting public health", async () => {
  const adapter: HelixAuthAdapter = {
    provider: "offline",
    async resolve() {
      throw new HelixAuthError("Identity offline", "unavailable");
    },
  };
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([]),
    createSpecialistFactory: () => new StubSpecialistFactory([], {}),
  });
  const app = createApp({ ctx, authAdapter: adapter });
  await request(app).get("/health").expect(200);
  await request(app).get("/runs").expect(503);
  await request(app).get("/auth/session").expect(503);
});

test("Acme adapter forwards bearer credentials and translates the external principal", async () => {
  let authorization = "";
  const adapter = createAcmeIdentityAuthAdapter({
    baseUrl: "http://identity.example",
    fetchFn: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        schemaVersion: "acme.principal.v1",
        sub: "service:7",
        iss: "acme-identity",
        username: "helix-bot",
        displayName: "Helix bot",
        roles: ["operator"],
        permissions: ["helix.trigger"],
        kind: "service",
        authMode: "local",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const resolved = await adapter.resolve({ authorization: "Bearer svc_secret" });
  assert.equal(authorization, "Bearer svc_secret");
  assert.equal(resolved.id, "service:7");
  assert.equal(resolved.kind, "service");
  assert.deepEqual(resolved.permissions, ["helix.trigger"]);
});
