import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoBootstrap, prependRepoContext } from "../src/context/bootstrap.js";
import { runIssue } from "../src/engine/engine.js";
import type { Issue, OrchestratorDecision, SpecialistDefinition, RunEvent } from "../src/engine/types.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { loadConfig } from "../src/config.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-ctx-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "docs"));
  mkdirSync(join(dir, ".helix", "context"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "demo",
      type: "module",
      scripts: { test: "node --test", build: "tsc" },
      dependencies: { express: "^5" },
      devDependencies: { typescript: "^5" },
    }),
  );
  writeFileSync(join(dir, "AGENTS.md"), "# Agents\nUse TypeScript.\n");
  writeFileSync(join(dir, "README.md"), "# Demo\nHello.\n");
  writeFileSync(join(dir, "docs", "plan.md"), "# Plan\nShip it.\n");
  writeFileSync(join(dir, ".helix", "context", "notes.md"), "Auth lives in src/auth.ts\n");
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  return dir;
}

test("buildRepoBootstrap includes tree, manifest, and allowlisted files", () => {
  const dir = makeRepo();
  const text = buildRepoBootstrap(dir, { includeGitDelta: false });
  assert.ok(text);
  assert.match(text!, /Repo bootstrap/);
  assert.match(text!, /Directory tree/);
  assert.match(text!, /src\//);
  assert.match(text!, /scripts: test, build/);
  assert.match(text!, /AGENTS\.md/);
  assert.match(text!, /Use TypeScript/);
  assert.match(text!, /\.helix\/context\/notes\.md/);
  assert.match(text!, /Auth lives in src\/auth\.ts/);
});

test("buildRepoBootstrap can be disabled", () => {
  const dir = makeRepo();
  assert.equal(buildRepoBootstrap(dir, { enabled: false }), undefined);
});

test("prependRepoContext prefixes task once", () => {
  assert.equal(prependRepoContext("do work", undefined), "do work");
  assert.match(prependRepoContext("do work", "## Repo bootstrap\nfacts"), /Repo bootstrap[\s\S]*do work/);
});

test("loadConfig defaults repoContext.enabled to true", () => {
  const dir = makeRepo();
  mkdirSync(join(dir, ".helix"), { recursive: true });
  writeFileSync(
    join(dir, ".helix", "config.json"),
    JSON.stringify({
      orchestrator: { workflow: ["planner"] },
    }),
  );
  const config = loadConfig(join(dir, ".helix"));
  assert.equal(config.repoContext?.enabled, true);
});

test("engine injects repoContext into first specialist wave only", async () => {
  const defs: SpecialistDefinition[] = [
    {
      name: "planner",
      description: "plans",
      systemPrompt: "plan",
      filePath: "/fake/planner.md",
      source: "project",
    },
    {
      name: "dev",
      description: "devs",
      systemPrompt: "dev",
      filePath: "/fake/dev.md",
      source: "project",
    },
  ];
  const factory = new StubSpecialistFactory(defs, {
    planner: "PLAN",
    dev: "DONE",
  });
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "planner", task: "plan it" }], reason: "plan" },
    { kind: "run", specialists: [{ specialist: "dev", task: "build it" }], reason: "dev" },
    { kind: "done", reason: "ok", deliverable: "x" },
  ];
  const issue: Issue = {
    source: "inline",
    title: "t",
    body: "b",
    labels: [],
  };
  const events: RunEvent[] = [];
  const bootstrap = "## Repo bootstrap\nlayout: src/";
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
    repoContext: bootstrap,
    onEvent: (_r, e) => events.push(e),
  });

  assert.equal(run.status, "done");
  assert.match(run.results[0].task, /Repo bootstrap/);
  assert.match(run.results[0].task, /plan it/);
  assert.equal(run.results[1].task, "build it");
  assert.equal(events[0].type, "run_started");
  assert.equal((events[0].details as { repoContextChars?: number })?.repoContextChars, bootstrap.length);
});
