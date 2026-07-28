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
import { resolveExportDirectory } from "../src/inception/pickup.js";
import { resolveInceptionSkills } from "../src/inception/skills.js";
import { resolveAdditionalSkillPaths } from "../src/agents/loaderBuilder.js";
import { createInceptionSpecialistFactory } from "../src/inception/specialists.js";
import { PiSpecialistSessionFactory, type PiSpecialistFactoryOptions } from "../src/agents/session.js";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { loadSpecialists } from "../src/agents/loader.js";
import type { OrchestratorDecision, SpecialistDefinition } from "../src/engine/types.js";
import type { PiProvider } from "../src/providers/openrouter.js";
import { validateDraftsForApply } from "../src/manage/validate.js";
import { loadManageInventory } from "../src/manage/inventory.js";
import { parseManageResponse } from "../src/manage/parseResponse.js";
import { loadConfig } from "../src/config.js";

function inceptionStubFactory(
  _provider: PiProvider,
  definitions: SpecialistDefinition[],
  _opts?: Omit<PiSpecialistFactoryOptions, "skillPack">,
) {
  return new StubSpecialistFactory(definitions, {
    architect: "# Foundation plan\n- layout\n- tooling\n",
    scaffolder: "Created README and src stubs.",
    validator: "PASS — foundation matches export.",
  });
}

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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  const catalogOpts = parseBootstrapArgs(
    ["--export-catalog", "http://127.0.0.1:8318", "--export-id", "7", "--execute"],
    cwd,
  );
  assert.equal(catalogOpts.exportCatalogUrl, "http://127.0.0.1:8318");
  assert.equal(catalogOpts.exportId, 7);
  assert.equal(catalogOpts.dryRun, false);
  assert.throws(
    () => parseBootstrapArgs(["--export", "/tmp/a", "--export-url", "http://x"], cwd),
    /only one/,
  );
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("materializeBootstrap refuses a target that already owns .git", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-materialize-git-"));
  gitInitHost(target);
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-git-"));

  assert.throws(
    () => materializeBootstrap({ pickup: loadBootstrapManifest(exportDir), targetDir: target }),
    /already has a Git repository/,
  );

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("materializeBootstrap refuses foreign non-empty workspace without force", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-materialize-dirty-"));
  writeFileSync(join(target, "notes.txt"), "keep me\n");
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-dirty-"));

  assert.throws(
    () => materializeBootstrap({ pickup: loadBootstrapManifest(exportDir), targetDir: target }),
    /not an empty workspace/,
  );

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("runBootstrapCommand works in empty non-git folder", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-bootstrap-empty-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-cmd-"));

  await runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: true,
    runAgents: false,
    force: false,
    cwd: target,
  });

  await runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: false,
    runAgents: false,
    force: false,
    cwd: target,
    provider: new FakeProvider(),
    createSpecialistFactory: inceptionStubFactory,
  });
  assert.ok(hasOwnGitDir(target));
  assert.ok(existsSync(join(target, ".helix", "agents", "planner.md")));
  assert.ok(existsSync(join(target, "docs", "inception", "FOUNDATION_PLAN.md")));
  assert.equal(getWorkspaceStatus(target).bootstrap.state, "completed");

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("getWorkspaceStatus disables bootstrap on git and PR on non-git", () => {
  const empty = mkdtempSync(join(tmpdir(), "helix-ws-empty-"));
  const emptyStatus = getWorkspaceStatus(empty);
  assert.equal(emptyStatus.bootstrap.available, true);
  assert.equal(emptyStatus.bootstrap.visible, true);
  assert.equal(emptyStatus.bootstrap.hasArtifacts, false);
  assert.equal(emptyStatus.bootstrap.state, "ready");
  assert.equal(emptyStatus.bootstrap.completed, false);
  assert.equal(emptyStatus.prReviews.available, false);
  assert.ok(emptyStatus.inception.skills.some((s) => s.name === "foundation"));
  assert.equal(emptyStatus.inception.skills[0]?.source, "built_in");

  const gitDir = mkdtempSync(join(tmpdir(), "helix-ws-git-"));
  gitInitHost(gitDir);
  const gitStatus = getWorkspaceStatus(gitDir);
  assert.equal(gitStatus.bootstrap.available, false);
  assert.equal(gitStatus.bootstrap.visible, false);
  assert.equal(gitStatus.bootstrap.hasArtifacts, false);
  assert.equal(gitStatus.bootstrap.state, "blocked");
  assert.equal(gitStatus.bootstrap.completed, false);
  assert.equal(gitStatus.prReviews.available, true);
  assert.match(gitStatus.bootstrap.reason ?? "", /without Helix bootstrap artifacts/);

  rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("getWorkspaceStatus marks awaiting_agents after materialize-only", () => {
  const target = mkdtempSync(join(tmpdir(), "helix-ws-completed-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-completed-"));
  materializeBootstrap({
    pickup: loadBootstrapManifest(exportDir),
    targetDir: target,
  });
  const status = getWorkspaceStatus(target);
  assert.equal(status.bootstrap.available, false);
  assert.equal(status.bootstrap.visible, true);
  assert.equal(status.bootstrap.hasArtifacts, true);
  assert.equal(status.bootstrap.completed, false);
  assert.equal(status.bootstrap.state, "awaiting_agents");
  assert.equal(status.bootstrap.canRunAgents, true);
  assert.match(status.bootstrap.reason ?? "", /inception agents have not finished/);
  assert.equal(status.prReviews.available, true);

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("getWorkspaceStatus marks completed after agents succeed", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-ws-agents-done-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-agents-done-"));
  await runBootstrap({
    exportPath: exportDir,
    targetDir: target,
    execute: true,
    provider: new FakeProvider(),
    createSpecialistFactory: inceptionStubFactory,
  });
  const status = getWorkspaceStatus(target);
  assert.equal(status.bootstrap.available, false);
  assert.equal(status.bootstrap.visible, true);
  assert.equal(status.bootstrap.hasArtifacts, true);
  assert.equal(status.bootstrap.completed, true);
  assert.equal(status.bootstrap.canRunAgents, false);
  assert.equal(status.bootstrap.state, "completed");
  assert.match(status.bootstrap.reason ?? "", /Bootstrap finished/);
  assert.match(
    execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: target, encoding: "utf8" }),
    /Helix bootstrap foundation/,
  );

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("createInceptionSpecialistFactory uses the inception skill pack", () => {
  const factory = createInceptionSpecialistFactory(new FakeProvider(), []);
  assert.ok(factory instanceof PiSpecialistSessionFactory);
  // skillPack is private; resolve paths is the contract bootstrap factories rely on
  const paths = resolveAdditionalSkillPaths(join(tmpdir(), "missing-helix"), "inception");
  assert.ok(paths.some((p) => p.includes("inception-skills")));
});

test("bootstrap HTTP API dry-run, execute, and runAgents", async () => {
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
  const app = createApp({ ctx, createBootstrapSpecialistFactory: inceptionStubFactory });

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
  assert.equal(exec.status, 202);
  assert.equal(exec.body.dryRun, false);
  assert.equal(exec.body.accepted, true);
  assert.ok(hasOwnGitDir(target));

  // Poll until agents finish (stub is sync-fast)
  let after = await request(app).get("/workspace");
  for (let i = 0; i < 40 && after.body.bootstrap.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 25));
    after = await request(app).get("/workspace");
  }
  assert.equal(after.body.bootstrap.available, false);
  assert.equal(after.body.bootstrap.visible, true);
  assert.equal(after.body.bootstrap.hasArtifacts, true);
  assert.equal(after.body.bootstrap.completed, true);
  assert.equal(after.body.bootstrap.state, "completed");
  assert.equal(after.body.prReviews.available, true);

  const blocked = await request(app).post("/bootstrap").send({ exportPath: exportDir, dryRun: true });
  assert.equal(blocked.status, 409);

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("runBootstrap dry-run returns preview without writing git", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-svc-dry-"));
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-svc-"));
  const preview = await runBootstrap({ exportPath: exportDir, targetDir: target, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(hasOwnGitDir(target), false);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("ensureInceptionScaffold creates .helix without git", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-scaffold-"));
  const result = ensureInceptionScaffold(target);
  assert.equal(result.created, true);
  assert.ok(existsSync(join(target, ".helix", "config.json")));
  assert.equal(hasOwnGitDir(target), false);

  // Bootstrap execute still allowed after serve scaffold
  const exportDir = writeExportFixture(join(tmpdir(), "helix-export-scaffold-"));
  await runBootstrapCommand({
    exportPath: exportDir,
    targetDir: target,
    dryRun: false,
    runAgents: false,
    force: false,
    cwd: target,
    provider: new FakeProvider(),
    createSpecialistFactory: inceptionStubFactory,
  });
  assert.ok(hasOwnGitDir(target));
  assert.equal(getWorkspaceStatus(target).bootstrap.state, "completed");

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("resolveExportDirectory pulls package URL into a local export tree", async () => {
  const exportDir = writeExportFixture(mkdtempSync(join(tmpdir(), "helix-pkg-src-")));
  const archive = join(mkdtempSync(join(tmpdir(), "helix-pkg-arc-")), "export.tgz");
  execFileSync("tar", ["-czf", archive, "-C", exportDir, "."], { stdio: "ignore" });
  const bytes = readFileSync(archive);
  const cacheDir = mkdtempSync(join(tmpdir(), "helix-pkg-cache-"));
  const source = await resolveExportDirectory({
    exportUrl: "http://catalog.test/api/exports/3/package",
    cacheDir,
    fetchFn: (async () =>
      new Response(bytes, { status: 200, headers: { "Content-Type": "application/gzip" } })) as typeof fetch,
  });
  assert.equal(source.kind, "package_url");
  assert.ok(existsSync(join(source.exportDir, "bootstrap.json")));
  const pickup = loadBootstrapManifest(source.exportDir);
  assert.equal(pickup.manifest.name, "Demo App");
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("runBootstrap from catalog marks adopt after agents complete", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-catalog-boot-"));
  const exportDir = writeExportFixture(mkdtempSync(join(tmpdir(), "helix-catalog-src-")));
  const archive = join(mkdtempSync(join(tmpdir(), "helix-catalog-arc-")), "export.tgz");
  execFileSync("tar", ["-czf", archive, "-C", exportDir, "."], { stdio: "ignore" });
  const bytes = readFileSync(archive);
  const adopts: Array<{ url: string; body: unknown }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/package")) {
      return new Response(bytes, { status: 200 });
    }
    if (url.endsWith("/adopt") && init?.method === "POST") {
      adopts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await runBootstrap({
    exportCatalogUrl: "http://catalog.test",
    exportId: 9,
    targetDir: target,
    execute: true,
    provider: new FakeProvider(),
    createSpecialistFactory: inceptionStubFactory,
    fetchFn,
  });
  assert.equal(result.dryRun, false);
  if (result.dryRun) throw new Error("expected execute");
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.catalogBaseUrl, "http://catalog.test");
  assert.equal(result.job.exportId, 9);
  assert.equal(adopts.length, 1);
  assert.match(adopts[0]!.url, /\/api\/exports\/9\/adopt$/);
  const source = JSON.parse(readFileSync(join(target, "docs", "inception", "SOURCE.json"), "utf-8")) as {
    sourceKind?: string;
    exportId?: number;
  };
  assert.equal(source.sourceKind, "catalog");
  assert.equal(source.exportId, 9);

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  rmSync(exportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("GET /bootstrap/export-catalog proxies soft catalog contract", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-catalog-proxy-"));
  ensureInceptionScaffold(target);
  const { createServer } = await import("node:http");
  const catalog = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        {
          id: 4,
          inceptionId: 2,
          inceptionName: "Widget",
          version: 1,
          createdAt: 1,
          adoptionStatus: "available",
          adoptedAt: null,
          adoptedBy: "",
          adoptionNote: "",
          summary: "Widget dashboard for ops.",
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", resolve));
  const addr = catalog.address();
  if (!addr || typeof addr === "string") throw new Error("expected port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const specialists = loadSpecialists(join(target, ".helix", "agents"));
  const ctx = createRunContext({
    cwd: target,
    helixDir: join(target, ".helix"),
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "ok" } satisfies OrchestratorDecision]),
    createSpecialistFactory: () => new StubSpecialistFactory(specialists, { planner: "ok", dev: "ok" }),
  });
  const app = createApp({ ctx, createBootstrapSpecialistFactory: inceptionStubFactory });
  const res = await request(app)
    .get("/bootstrap/export-catalog")
    .query({ baseUrl, status: "all" });
  assert.equal(res.status, 200);
  assert.equal(res.body[0]?.inceptionName, "Widget");
  assert.equal(res.body[0]?.summary, "Widget dashboard for ops.");
  assert.equal(res.body[0]?.id, 4);

  await new Promise<void>((resolve, reject) => catalog.close((err) => (err ? reject(err) : resolve())));
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test("GET /bootstrap/export-catalog/status reports online and offline", async () => {
  const target = mkdtempSync(join(tmpdir(), "helix-catalog-status-"));
  ensureInceptionScaffold(target);
  const { createServer } = await import("node:http");
  const online = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => online.listen(0, "127.0.0.1", resolve));
  const addr = online.address();
  if (!addr || typeof addr === "string") throw new Error("expected port");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const specialists = loadSpecialists(join(target, ".helix", "agents"));
  const ctx = createRunContext({
    cwd: target,
    helixDir: join(target, ".helix"),
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
    createOrchestrator: () => new ScriptedOrchestrator([{ kind: "done", reason: "ok" } satisfies OrchestratorDecision]),
    createSpecialistFactory: () => new StubSpecialistFactory(specialists, { planner: "ok", dev: "ok" }),
  });
  const app = createApp({ ctx, createBootstrapSpecialistFactory: inceptionStubFactory });

  const up = await request(app).get("/bootstrap/export-catalog/status").query({ baseUrl });
  assert.equal(up.status, 200);
  assert.equal(up.body.status, "online");
  assert.equal(up.body.healthUrl, `${baseUrl}/api/health`);

  const down = await request(app)
    .get("/bootstrap/export-catalog/status")
    .query({ baseUrl: "http://127.0.0.1:9" });
  assert.equal(down.status, 200);
  assert.equal(down.body.status, "offline");

  const empty = await request(app).get("/bootstrap/export-catalog/status").query({ baseUrl: "" });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.status, "unconfigured");

  await new Promise<void>((resolve, reject) => online.close((err) => (err ? reject(err) : resolve())));
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
