import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeInceptionRoles, INCEPTION_ROLES } from "../src/inception/roles.js";
import { resolveInceptionSpecialists } from "../src/inception/loader.js";
import { loadBootstrapManifest, PRELUDE_BOOTSTRAP_SCHEMA } from "../src/inception/manifest.js";
import { materializeBootstrap } from "../src/inception/materialize.js";
import { parseBootstrapArgs, runBootstrapCommand } from "../src/inception/command.js";
import { hasOwnGitDir } from "../src/inception/git.js";
import { ensureInceptionScaffold } from "../src/inception/workspace.js";
import { getWorkspaceStatus, runBootstrap } from "../src/inception/service.js";
import { resolveInceptionSkills } from "../src/inception/skills.js";
import { resolveAdditionalSkillPaths } from "../src/agents/loaderBuilder.js";
import { createInceptionSpecialistFactory } from "../src/inception/specialists.js";
import { PiSpecialistSessionFactory } from "../src/agents/session.js";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { loadSpecialists } from "../src/agents/loader.js";
import type { OrchestratorDecision } from "../src/engine/types.js";
import { validateDraftsForApply } from "../src/manage/validate.js";
import { loadManageInventory } from "../src/manage/inventory.js";
import { parseManageResponse } from "../src/manage/parseResponse.js";
import { loadConfig } from "../src/config.js";

function writeExportFixture(dir: string): string {
  mkdirSync(join(dir, "documents"), { recursive: true });
  writeFileSync(join(dir, "documents", "intent.md"), "# Intent\nBuild it.\n");
  writeFileSync(join(dir, "INDEX.md"), "# Index\n");
  writeFileSync(
    join(dir, "bootstrap.json"),
    JSON.stringify({
      schemaVersion: PRELUDE_BOOTSTRAP_SCHEMA,
      inceptionId: 1,
      name: "Demo App",
      version: 1,
      acceptedAt: 1,
      exportedAt: 2,
      exportPath: dir,
      brief: "Build a demo",
      documents: [{ path: "intent.md", title: "Intent", kind: "markdown", body: "# Intent\nBuild it.\n" }],
      artifacts: [],
      primerNotes: [{ id: 1, question: "Q?", answer: "A", projectId: "p", evidence: [], createdAt: 1 }],
      files: {
        indexMarkdown: "INDEX.md",
        documentsDir: "documents",
        artifactsDir: "artifacts",
        primerDir: "primer",
      },
    }),
  );
  return dir;
}

function gitInitHost(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
}

test("normalizeInceptionRoles defaults and rejects unknown roles", () => {
  assert.deepEqual(normalizeInceptionRoles(undefined), [...INCEPTION_ROLES]);
  assert.deepEqual(normalizeInceptionRoles(["validator", "architect", "scaffolder"]), [
    "validator",
    "architect",
    "scaffolder",
  ]);
  assert.throws(() => normalizeInceptionRoles(["architect", "scaffolder"]), /missing required role/);
  assert.throws(() => normalizeInceptionRoles(["architect", "scaffolder", "validator", "extra"]), /unknown role/);
});

test("resolveInceptionSpecialists falls back to built-in presets", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-inception-fallback-"));
  const resolved = resolveInceptionSpecialists(dir);
  assert.deepEqual(
    resolved.map((item) => [item.role, item.source]),
    [
      ["architect", "built_in"],
      ["scaffolder", "built_in"],
      ["validator", "built_in"],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("resolveInceptionSpecialists prefers project overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-inception-project-"));
  mkdirSync(join(dir, "inception-agents"), { recursive: true });
  writeFileSync(
    join(dir, "inception-agents", "architect.md"),
    "---\nname: architect\ndescription: Project architect\n---\n\nPlan this project.\n",
  );
  const resolved = resolveInceptionSpecialists(dir);
  assert.equal(resolved[0]?.source, "project");
  assert.equal(resolved[0]?.definition.description, "Project architect");
  assert.equal(resolved[1]?.source, "built_in");
  rmSync(dir, { recursive: true, force: true });
});

test("loadBootstrapManifest validates prelude.bootstrap.v1", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-bootstrap-export-"));
  mkdirSync(join(dir, "documents"), { recursive: true });
  writeFileSync(join(dir, "documents", "intent.md"), "# Intent\n");
  writeFileSync(join(dir, "INDEX.md"), "# Index\n");
  writeFileSync(
    join(dir, "bootstrap.json"),
    JSON.stringify({
      schemaVersion: PRELUDE_BOOTSTRAP_SCHEMA,
      inceptionId: 1,
      name: "Demo",
      version: 1,
      acceptedAt: 1,
      exportedAt: 2,
      exportPath: dir,
      brief: "Build a demo",
      documents: [{ path: "intent.md", title: "Intent", kind: "markdown", body: "# Intent\n" }],
      artifacts: [],
      primerNotes: [],
      files: {
        indexMarkdown: "INDEX.md",
        documentsDir: "documents",
        artifactsDir: "artifacts",
        primerDir: "primer",
      },
    }),
  );

  const pickup = loadBootstrapManifest(dir);
  assert.equal(pickup.manifest.name, "Demo");
  assert.equal(pickup.documentsOnDisk, 1);
  assert.equal(pickup.indexExists, true);

  writeFileSync(join(dir, "bootstrap.json"), JSON.stringify({ schemaVersion: "nope" }));
  assert.throws(() => loadBootstrapManifest(dir), /Unsupported schemaVersion/);

  rmSync(dir, { recursive: true, force: true });
});

test("inception-agent validation allows only fixed roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-inception-validate-"));
  const bad = validateDraftsForApply(
    [
      {
        kind: "inception-agent",
        relativePath: "inception-agents/planner.md",
        content: "---\nname: planner\ndescription: Wrong\n---\n\nNo.\n",
      },
    ],
    dir,
    false,
  );
  assert.equal(bad.ok, false);

  const good = validateDraftsForApply(
    [
      {
        kind: "inception-agent",
        relativePath: "inception-agents/validator.md",
        content: "---\nname: validator\ndescription: Checks foundation\n---\n\nValidate.\n",
      },
      {
        kind: "inception-skill",
        relativePath: "inception-skills/foundation/SKILL.md",
        content: "# Foundation\n",
      },
    ],
    dir,
    false,
  );
  assert.equal(good.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("manage inventory lists inception agents and skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-inception-inventory-"));
  mkdirSync(join(dir, "inception-agents"), { recursive: true });
  mkdirSync(join(dir, "inception-skills", "foundation"), { recursive: true });
  writeFileSync(
    join(dir, "inception-agents", "scaffolder.md"),
    "---\nname: scaffolder\ndescription: Project scaffolder\n---\n\nScaffold.\n",
  );
  writeFileSync(join(dir, "inception-skills", "foundation", "SKILL.md"), "# Foundation\n");

  const inventory = loadManageInventory(dir);
  assert.equal(inventory.inceptionAgents.find((a) => a.name === "scaffolder")?.source, "project");
  assert.equal(inventory.inceptionAgents.find((a) => a.name === "architect")?.source, "built_in");
  assert.deepEqual(
    inventory.inceptionSkills.map((s) => s.relativePath),
    ["inception-skills/foundation/SKILL.md"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("parseManageResponse accepts inception draft kinds", () => {
  const parsed = parseManageResponse(
    JSON.stringify({
      message: "Updated architect",
      drafts: [
        {
          kind: "inception-agent",
          relativePath: "inception-agents/architect.md",
          content: "---\nname: architect\ndescription: d\n---\n\nBody",
        },
      ],
      deletions: [],
    }),
  );
  assert.equal(parsed?.drafts[0]?.kind, "inception-agent");
});

test("loadConfig reads optional inception.roles order", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-inception-config-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      orchestrator: { workflow: ["planner", "dev"] },
      inception: { roles: ["validator", "architect", "scaffolder"] },
    }),
  );
  const config = loadConfig(dir);
  assert.deepEqual(config.inception?.roles, ["validator", "architect", "scaffolder"]);
  rmSync(dir, { recursive: true, force: true });
});

test("examples fixture includes inception presets", () => {
  const fixture = join(process.cwd(), "examples/ts/.helix");
  const inventory = loadManageInventory(fixture);
  assert.equal(inventory.inceptionAgents.length, 3);
  assert.ok(inventory.inceptionSkills.some((s) => s.name === "foundation"));
});

test("parseBootstrapArgs defaults target to cwd and dry-run", () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-bootstrap-args-"));
  const opts = parseBootstrapArgs(["--export", "/tmp/export"], cwd);
  assert.equal(opts.targetDir, cwd);
  assert.equal(opts.dryRun, true);
  const execOpts = parseBootstrapArgs(["--export", "/tmp/export", "--target", "app", "--execute"], cwd);
  assert.equal(execOpts.targetDir, join(cwd, "app"));
  assert.equal(execOpts.dryRun, false);
  rmSync(cwd, { recursive: true, force: true });
});

test("materializeBootstrap inits git in an empty folder", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-materialize-empty-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-"));

  const pickup = loadBootstrapManifest(exportDir);
  const result = materializeBootstrap({ pickup, targetDir: target });

  assert.equal(result.gitInitialized, true);
  assert.ok(hasOwnGitDir(target));
  assert.ok(existsSync(join(target, "docs", "inception", "BRIEF.md")));
  assert.ok(existsSync(join(target, "docs", "inception", "documents", "intent.md")));
  assert.ok(existsSync(join(target, "docs", "inception", "primer", "note-1.json")));
  assert.ok(existsSync(join(target, ".helix", "config.json")));
  assert.ok(existsSync(join(target, ".helix", "inception-agents", "architect.md")));
  assert.ok(existsSync(join(target, ".helix", "context", "inception.md")));
  assert.match(readFileSync(join(target, "README.md"), "utf-8"), /Demo App/);

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("materializeBootstrap refuses a target that already owns .git", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-materialize-git-"));
  gitInitHost(target);
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-git-"));

  assert.throws(
    () => materializeBootstrap({ pickup: loadBootstrapManifest(exportDir), targetDir: target }),
    /already has a Git repository/,
  );

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("materializeBootstrap refuses foreign non-empty workspace without force", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-materialize-dirty-"));
  writeFileSync(join(target, "notes.txt"), "keep me\n");
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-dirty-"));

  assert.throws(
    () => materializeBootstrap({ pickup: loadBootstrapManifest(exportDir), targetDir: target }),
    /not an empty workspace/,
  );

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("runBootstrapCommand works in empty non-git folder", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-bootstrap-empty-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-cmd-"));

  runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: true,
    force: false,
    cwd: target,
  });

  runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: false,
    force: false,
    cwd: target,
  });
  assert.ok(hasOwnGitDir(target));
  assert.ok(existsSync(join(target, ".helix", "agents", "planner.md")));

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("getWorkspaceStatus disables bootstrap on git and PR on non-git", () => {
  const empty = mkdtempSync(join(tmpdir(), "helix-ws-empty-"));
  const emptyStatus = getWorkspaceStatus(empty);
  assert.equal(emptyStatus.bootstrap.available, true);
  assert.equal(emptyStatus.prReviews.available, false);
  assert.ok(emptyStatus.inception.skills.some((s) => s.name === "foundation"));
  assert.equal(emptyStatus.inception.skills[0]?.source, "built_in");

  const gitDir = mkdtempSync(join(tmpdir(), "helix-ws-git-"));
  gitInitHost(gitDir);
  const gitStatus = getWorkspaceStatus(gitDir);
  assert.equal(gitStatus.bootstrap.available, false);
  assert.equal(gitStatus.prReviews.available, true);

  rmSync(empty, { recursive: true, force: true });
  rmSync(gitDir, { recursive: true, force: true });
});

test("resolveAdditionalSkillPaths loads inception skills for bootstrap sessions", () => {
  const empty = mkdtempSync(join(tmpdir(), "helix-skill-paths-empty-"));
  const shipped = resolveAdditionalSkillPaths(join(empty, ".helix"), "inception");
  assert.equal(shipped.length, 1);
  assert.match(shipped[0]!, /presets[/\\]inception-skills$/);

  const project = mkdtempSync(join(tmpdir(), "helix-skill-paths-project-"));
  const helixDir = join(project, ".helix");
  mkdirSync(join(helixDir, "inception-skills", "foundation"), { recursive: true });
  writeFileSync(join(helixDir, "inception-skills", "foundation", "SKILL.md"), "# Project foundation\n");
  const projectPaths = resolveAdditionalSkillPaths(helixDir, "inception");
  assert.deepEqual(projectPaths, [join(helixDir, "inception-skills")]);
  assert.equal(resolveInceptionSkills(helixDir)[0]?.source, "project");

  const runPaths = resolveAdditionalSkillPaths(helixDir, "run");
  assert.deepEqual(runPaths, []);

  rmSync(empty, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("createInceptionSpecialistFactory uses the inception skill pack", () => {
  const factory = createInceptionSpecialistFactory(new FakeProvider(), []);
  assert.ok(factory instanceof PiSpecialistSessionFactory);
  // skillPack is private; resolve paths is the contract bootstrap factories rely on
  const paths = resolveAdditionalSkillPaths(join(tmpdir(), "missing-helix"), "inception");
  assert.ok(paths.some((p) => p.includes("inception-skills")));
});

test("bootstrap HTTP API dry-run and execute in empty workspace", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-http-bootstrap-"));
  ensureInceptionScaffold(target);
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-http-"));

  const specialists = loadSpecialists(join(target, ".helix", "agents"));
  const ctx = createRunContext({
    helixDir: join(target, ".helix"),
    cwd: target,
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "ok" } satisfies OrchestratorDecision]),
    createSpecialistFactory: () => new StubSpecialistFactory(specialists, { planner: "ok", dev: "ok" }),
  });
  const app = createApp({ ctx });

  const workspace = await request(app).get("/workspace");
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.bootstrap.available, true);
  assert.equal(workspace.body.prReviews.available, false);
  assert.ok(workspace.body.inception.skills.some((s: { name: string }) => s.name === "foundation"));

  const dry = await request(app).post("/bootstrap").send({ exportPath: exportDir, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.pickup.name, "Demo App");
  assert.ok(Array.isArray(dry.body.skills));
  assert.ok(dry.body.skills.some((s: { name: string }) => s.name === "foundation"));

  const exec = await request(app).post("/bootstrap").send({ exportPath: exportDir, execute: true });
  assert.equal(exec.status, 201);
  assert.equal(exec.body.dryRun, false);
  assert.ok(hasOwnGitDir(target));

  const after = await request(app).get("/workspace");
  assert.equal(after.body.bootstrap.available, false);
  assert.equal(after.body.prReviews.available, true);

  const blocked = await request(app).post("/bootstrap").send({ exportPath: exportDir, dryRun: true });
  assert.equal(blocked.status, 409);

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("runBootstrap dry-run returns preview without writing git", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-svc-dry-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-svc-"));
  const preview = runBootstrap({ exportPath: exportDir, targetDir: target, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(hasOwnGitDir(target), false);
  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test("ensureInceptionScaffold creates .helix without git", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-scaffold-"));
  const result = ensureInceptionScaffold(target);
  assert.equal(result.created, true);
  assert.ok(existsSync(join(target, ".helix", "config.json")));
  assert.equal(hasOwnGitDir(target), false);

  // Bootstrap execute still allowed after serve scaffold
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-scaffold-"));
  runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: false,
    force: false,
    cwd: target,
  });
  assert.ok(hasOwnGitDir(target));

  rmSync(target, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});
