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
import { buildConfigSnapshot } from "../src/config/snapshot.js";
import { HELIX_MODEL_ENV } from "../src/config/env.js";
import { HELIX_DEFAULT_MODEL } from "../src/config/defaults.js";
import type { OrchestratorDecision } from "../src/engine/types.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";

const fixtureDir = resolve("examples/ts/.helix");

function testCtx() {
  const store = new MemoryRunStore();
  const specialists = loadSpecialists(resolve(fixtureDir, "agents"));
  const factory = new StubSpecialistFactory(specialists, { planner: "ok", dev: "ok", verifier: "ok" });
  const script: OrchestratorDecision[] = [{ kind: "done", reason: "ok" }];

  const ctx = createRunContext({
    helixDir: fixtureDir,
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator(script),
    createSpecialistFactory: () => factory,
  });

  return ctx;
}

test("buildConfigSnapshot reports resolved models and provenance", () => {
  const prev = process.env[HELIX_MODEL_ENV];
  delete process.env[HELIX_MODEL_ENV];
  try {
    const ctx = testCtx();
    const snap = buildConfigSnapshot(ctx);

    assert.equal(snap.paths.helixDir, fixtureDir);
    assert.equal(snap.provider.name, "openrouter");
    assert.equal(snap.provider.authConfigured, true);
    assert.equal(snap.models.orchestrator.value, HELIX_DEFAULT_MODEL);
    assert.equal(snap.models.orchestrator.source, "default");
    assert.equal(snap.models.helixModelEnvSet, false);
    assert.ok(snap.models.specialists.length >= 1);
    assert.ok(snap.workflow.steps.includes("planner"));
    assert.equal(typeof snap.flags.extensionsEnabled, "boolean");
    assert.equal(snap.flags.deliverableLocalPr, true);
    assert.ok(!("inheritPi" in snap.flags));
    assert.ok(!("helixHome" in snap.paths));
  } finally {
    if (prev === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = prev;
  }
});

test("buildConfigSnapshot marks HELIX_MODEL as default source; agent model wins when set", () => {
  const prev = process.env[HELIX_MODEL_ENV];
  process.env[HELIX_MODEL_ENV] = "openrouter/test/override-model";
  try {
    const ctx = testCtx();
    const snap = buildConfigSnapshot(ctx);
    assert.equal(snap.models.helixModelEnvSet, true);
    assert.equal(snap.models.orchestrator.source, "env");
    assert.equal(snap.models.orchestrator.value, "openrouter/test/override-model");
    // Fixture specialists have no frontmatter model → inherit default provenance
    for (const sp of snap.models.specialists) {
      assert.equal(sp.model.source, "env");
      assert.equal(sp.model.value, "openrouter/test/override-model");
    }
  } finally {
    if (prev === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = prev;
  }
});

test("GET /config serves UI and GET /config/snapshot returns JSON", async () => {
  const ctx = testCtx();
  const app = createApp({ ctx });

  const page = await request(app).get("/config");
  assert.equal(page.status, 200);
  assert.match(page.text, /id="root"/);

  const snap = await request(app).get("/config/snapshot");
  assert.equal(snap.status, 200);
  assert.equal(snap.body.paths.helixDir, fixtureDir);
  assert.ok(snap.body.models.orchestrator.value);
  assert.ok(Array.isArray(snap.body.models.specialists));
  assert.ok(snap.body.workflow.steps.length >= 1);
  assert.equal(snap.body.provider.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(typeof snap.body.provider.authConfigured, "boolean");
  assert.ok(!JSON.stringify(snap.body).includes("sk-"));
});

test("all primary web routes serve the React shell", async () => {
  const ctx = testCtx();
  const app = createApp({ ctx });

  for (const path of ["/", "/reviews", "/manage", "/config"]) {
    const page = await request(app).get(path);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="root"/);
  }
});
