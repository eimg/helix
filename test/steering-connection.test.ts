import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { AppSettingsStore } from "../src/state/appSettings.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";

describe("Helix Steering connection", () => {
  let helixDir: string;
  let appSettings: AppSettingsStore;
  let app: ReturnType<typeof createApp>;

  before(() => {
    helixDir = mkdtempSync(join(tmpdir(), "helix-steering-settings-"));
    writeFileSync(join(helixDir, "config.json"), JSON.stringify({
      extensions: { enabled: false },
      repoContext: { enabled: false },
      deliverable: { pr: false, localPr: false },
      orchestrator: { workflow: ["planner", "dev"], maxIterations: 4 },
    }));
    appSettings = new AppSettingsStore(helixDir);
    const ctx = createRunContext({
      helixDir,
      store: new MemoryRunStore(),
      provider: new FakeProvider(),
      deliverable: new NoOpDeliverablePipeline(),
      createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "unused" }]),
      createSpecialistFactory: () => new StubSpecialistFactory([], {}),
    });
    app = createApp({
      ctx,
      appSettings,
      fetchFn: async (input) => {
        const url = new URL(String(input));
        if (url.host === "steering.test" && url.pathname === "/api/health") {
          return Response.json({ ok: true, product: "acme-steering" });
        }
        if (url.host === "steering.test" && url.pathname === "/api/notifications/check") {
          return Response.json({ ok: true, product: "helix" });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
  });

  after(() => {
    appSettings.close();
    rmSync(helixDir, { recursive: true, force: true });
  });

  it("manages and tests the optional Steering connection without storing credentials", async () => {
    const saved = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: "http://steering.test/" })
      .expect(200);
    assert.equal(saved.body.url, "http://steering.test");
    assert.equal(saved.body.source, "stored");
    assert.equal(saved.body.status, "online");

    const tested = await request(app).post("/api/integrations/steering/test").expect(200);
    assert.equal(tested.body.status, "online");
    assert.equal(Object.hasOwn(tested.body, "token"), false);

    const disabled = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: "" })
      .expect(200);
    assert.equal(disabled.body.configured, false);
    assert.equal(disabled.body.source, "stored");

    const reset = await request(app)
      .patch("/api/integrations/steering")
      .send({ url: null })
      .expect(200);
    assert.equal(reset.body.source, "unconfigured");
  });
});
