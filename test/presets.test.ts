import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { loadWorkflow, describeWorkflow } from "../src/orchestrator/workflow.js";

const fixtureDir = resolve(import.meta.dirname, "..", "examples", "ts", ".helix");

test("config: loads and validates the TS fixture config (wiring only)", () => {
  const config = loadConfig(fixtureDir);
  assert.deepEqual(config.orchestrator.workflow, ["planner", "dev", "verifier"]);
  assert.equal(config.orchestrator.maxIterations, 6);
  assert.equal(config.triggers?.github?.repo, "acme/widget");
  assert.equal(config.mergeGate?.requireVerifierPass, true);
  assert.equal(config.extensions?.enabled, false);
  assert.ok(!("provider" in config));
  assert.ok(!("inheritPi" in config));
  assert.ok(!("model" in config.orchestrator));
});

test("config: extensions default to false when absent; ignores legacy essentials fields", () => {
  const tmp = mkdtempSync(join(tmpdir(), "helix-cfg-"));
  writeFileSync(join(tmp, "config.json"), JSON.stringify({
    provider: { name: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    inheritPi: true,
    orchestrator: {
      model: "openrouter/x",
      workflow: ["dev"],
      loops: { "verifier-fail": { backTo: "dev", maxRetries: 2 } },
    },
  }));
  const config = loadConfig(tmp);
  assert.equal(config.extensions?.enabled, false);
  assert.equal(config.deliverable?.pr, false);
  assert.deepEqual(config.orchestrator.workflow, ["dev"]);
  assert.ok(!("model" in config.orchestrator));
  assert.ok(!("loops" in config.orchestrator));
  assert.ok(!("inheritPi" in config));
});

test("config: deliverable.pr can be enabled explicitly", () => {
  const tmp = mkdtempSync(join(tmpdir(), "helix-cfg-pr-"));
  writeFileSync(join(tmp, "config.json"), JSON.stringify({
    orchestrator: { workflow: ["dev"] },
    deliverable: { pr: true },
  }));
  const config = loadConfig(tmp);
  assert.equal(config.deliverable?.pr, true);
});

test("loader: discovers the three preset specialists with frontmatter + body", () => {
  const defs = loadSpecialists(resolve(fixtureDir, "agents"));
  assert.equal(defs.length, 3);
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ["dev", "planner", "verifier"]);
  const planner = defs.find((d) => d.name === "planner")!;
  assert.ok(planner.description.length > 0);
  assert.equal(planner.model, undefined);
  assert.ok(planner.systemPrompt.length > 0);
  assert.ok(planner.tools?.includes("read"));
  assert.equal(planner.source, "project");
});

test("workflow: loads steps, iteration cap, merge gate, and renders rails text", () => {
  const config = loadConfig(fixtureDir);
  const wf = loadWorkflow(config);
  assert.deepEqual(wf.steps, ["planner", "dev", "verifier"]);
  assert.equal(wf.mergeGate.autoMerge, true);
  assert.equal(wf.maxIterations, 6);
  const text = describeWorkflow(wf);
  assert.match(text, /planner → dev → verifier/);
  assert.match(text, /Hard iteration cap: 6/);
});

test("loader: returns empty list for a missing agents dir", () => {
  const defs = loadSpecialists(resolve(fixtureDir, "does-not-exist"));
  assert.deepEqual(defs, []);
});
