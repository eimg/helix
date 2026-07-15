import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { parseManageResponse } from "../src/manage/parseResponse.js";
import { validateDraftsForApply } from "../src/manage/validate.js";
import { applyDrafts } from "../src/manage/apply.js";
import { applyDeletions } from "../src/manage/delete.js";
import { ManageService } from "../src/manage/service.js";
import { FakeManageAuthor } from "../src/manage/fakeAuthor.js";
import { MemoryManageStore } from "../src/manage/store.js";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { loadConfig } from "../src/config.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";

const fixtureDir = join(process.cwd(), "examples/ts/.helix");

test("parseManageResponse extracts message and drafts", () => {
  const text = `Here you go:\n{"message":"Created agent","drafts":[{"kind":"agent","relativePath":"agents/x.md","content":"---\\nname: x\\ndescription: d\\n---\\n\\nbody"}],"deletions":[]}`;
  const parsed = parseManageResponse(text);
  assert.ok(parsed);
  assert.equal(parsed!.message, "Created agent");
  assert.equal(parsed!.drafts.length, 1);
  assert.equal(parsed!.drafts[0].relativePath, "agents/x.md");
});

test("parseManageResponse extracts deletions", () => {
  const text = `{"message":"Remove skill","drafts":[],"deletions":[{"kind":"skill","relativePath":"skills/test/SKILL.md"}]}`;
  const parsed = parseManageResponse(text);
  assert.ok(parsed);
  assert.equal(parsed!.deletions.length, 1);
  assert.equal(parsed!.deletions[0].relativePath, "skills/test/SKILL.md");
});

test("applyDrafts writes agent and skill under helix dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-"));
  const drafts = [
    {
      kind: "agent" as const,
      relativePath: "agents/sample.md",
      content: "---\nname: sample\ndescription: Test agent\n---\n\nDo things.\n",
    },
    {
      kind: "skill" as const,
      relativePath: "skills/sample/SKILL.md",
      content: "# Sample\n\nRun tests.\n",
    },
  ];

  const validation = validateDraftsForApply(drafts, dir, false);
  assert.equal(validation.ok, true);

  const result = applyDrafts(dir, drafts, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.written, ["agents/sample.md", "skills/sample/SKILL.md"]);

  assert.match(readFileSync(join(dir, "agents/sample.md"), "utf-8"), /name: sample/);
  assert.match(readFileSync(join(dir, "skills/sample/SKILL.md"), "utf-8"), /# Sample/);

  rmSync(dir, { recursive: true, force: true });
});

test("applyDeletions removes skill directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-del-"));
  const skillPath = join(dir, "skills", "test", "SKILL.md");
  mkdirSync(join(dir, "skills", "test"), { recursive: true });
  writeFileSync(skillPath, "# Test\n");

  const result = applyDeletions(dir, [{ kind: "skill", relativePath: "skills/test/SKILL.md" }]);
  assert.equal(result.ok, true);
  assert.equal(existsSync(skillPath), false);

  rmSync(dir, { recursive: true, force: true });
});

test("ManageService session produces drafts and apply writes files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-svc-"));
  const config = loadConfig(fixtureDir);
  const service = new ManageService({
    helixDir: dir,
    config,
    model: "openrouter/test/model",
    provider: new FakeProvider(),
    store: new MemoryManageStore(),
    createAuthor: () => new FakeManageAuthor(),
  });

  const { id, promise } = service.startSession("create a skill");
  await promise;

  const session = service.getSession(id)!;
  assert.equal(session.status, "active");
  assert.ok(session.drafts.length > 0);

  const applied = service.applySession(id, false);
  assert.equal(applied.status, "applied");
  assert.ok(readFileSync(join(dir, "skills/sample/SKILL.md"), "utf-8"));

  rmSync(dir, { recursive: true, force: true });
});

test("ManageService delete skill via apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-del-svc-"));
  mkdirSync(join(dir, "skills", "test"), { recursive: true });
  writeFileSync(join(dir, "skills", "test", "SKILL.md"), "# Test skill\n");

  const config = loadConfig(fixtureDir);
  const service = new ManageService({
    helixDir: dir,
    config,
    model: "openrouter/test/model",
    provider: new FakeProvider(),
    store: new MemoryManageStore(),
    createAuthor: () => new FakeManageAuthor(),
  });

  const { id, promise } = service.startSession("delete test skill");
  await promise;

  const session = service.getSession(id)!;
  assert.ok(session.deletions.length > 0);

  const applied = service.applySession(id, false);
  assert.equal(applied.status, "applied");
  assert.equal(existsSync(join(dir, "skills", "test", "SKILL.md")), false);

  rmSync(dir, { recursive: true, force: true });
});

test("manage API: session, events, apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-api-"));
  const config = loadConfig(fixtureDir);
  const manage = new ManageService({
    helixDir: dir,
    config,
    model: "openrouter/test/model",
    provider: new FakeProvider(),
    createAuthor: () => new FakeManageAuthor(),
  });

  const ctx = createRunContext({ helixDir: fixtureDir, store: new MemoryRunStore() });
  const app = createApp({ ctx, manage });

  const page = await request(app).get("/manage");
  assert.equal(page.status, 200);
  assert.match(page.text, /Manage/);

  const agents = await request(app).get("/manage/agents");
  assert.equal(agents.status, 200);
  assert.ok(Array.isArray(agents.body));

  const start = await request(app).post("/manage/sessions").send({ prompt: "create an agent" });
  assert.equal(start.status, 202);
  const id = start.body.id as string;

  await new Promise((r) => setTimeout(r, 50));

  const session = await request(app).get(`/manage/sessions/${id}`);
  assert.equal(session.status, 200);
  assert.ok(session.body.drafts.length > 0);

  const events = await request(app).get(`/manage/sessions/${id}/events`);
  assert.equal(events.status, 200);
  assert.match(events.text, /assistant_replied/);

  const applied = await request(app).post(`/manage/sessions/${id}/apply`).send({ force: false });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.status, "applied");

  rmSync(dir, { recursive: true, force: true });
});

test("manage workflow API reorders available agents and preserves other config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-workflow-"));
  const helixDir = join(dir, ".helix");
  cpSync(fixtureDir, helixDir, { recursive: true });
  const ctx = createRunContext({ helixDir, store: new MemoryRunStore(), provider: new FakeProvider() });
  const app = createApp({ ctx });

  const before = await request(app).get("/manage/workflow");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.steps, ["planner", "dev", "verifier"]);

  const saved = await request(app).put("/manage/workflow").send({ steps: ["dev", "verifier", "planner"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.steps, ["dev", "verifier", "planner"]);

  const config = JSON.parse(readFileSync(join(helixDir, "config.json"), "utf-8"));
  assert.deepEqual(config.orchestrator.workflow, ["dev", "verifier", "planner"]);
  assert.equal(config.orchestrator.maxIterations, 6);
  assert.equal(config.repoContext.enabled, true);

  const snapshot = await request(app).get("/config/snapshot");
  assert.deepEqual(snapshot.body.workflow.steps, ["dev", "verifier", "planner"]);

  const duplicate = await request(app).put("/manage/workflow").send({ steps: ["dev", "dev"] });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error, /duplicate agent/);

  const unknown = await request(app).put("/manage/workflow").send({ steps: ["missing"] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown workflow agent/);

  const empty = await request(app).put("/manage/workflow").send({ steps: [] });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /at least one agent/);

  rmSync(dir, { recursive: true, force: true });
});

test("new runs reload workflow and agents saved while the server is running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-manage-reload-"));
  const helixDir = join(dir, ".helix");
  cpSync(fixtureDir, helixDir, { recursive: true });
  let observedSteps: string[] = [];
  let observedAgents: string[] = [];
  const ctx = createRunContext({
    helixDir,
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    createOrchestrator: (current) => {
      observedSteps = [...current.workflow.steps];
      return {
        async decide(input) {
          observedAgents = input.specialists.map((specialist) => specialist.name);
          return { kind: "done" as const, reason: "ok" };
        },
      };
    },
    createSpecialistFactory: (current) => new StubSpecialistFactory(current.specialists, {}),
  });
  const app = createApp({ ctx });

  writeFileSync(join(helixDir, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews changes\n---\n\nReview carefully.\n");
  const saved = await request(app).put("/manage/workflow").send({ steps: ["planner", "reviewer", "dev", "verifier"] });
  assert.equal(saved.status, 200);

  const started = await request(app).post("/runs").send({ title: "Reload resources" });
  assert.equal(started.status, 202);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));

  assert.deepEqual(observedSteps, ["planner", "reviewer", "dev", "verifier"]);
  assert.ok(observedAgents.includes("reviewer"));

  rmSync(dir, { recursive: true, force: true });
});
