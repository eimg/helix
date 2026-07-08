import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { loadWorkflow, describeWorkflow } from "../src/orchestrator/workflow.js";

const fixtureDir = resolve(import.meta.dirname, "..", "examples", "ts", ".helix");

test("config: loads and validates the TS fixture config", () => {
  const config = loadConfig(fixtureDir);
  assert.equal(config.provider.name, "openrouter");
  assert.equal(config.orchestrator.model, "openrouter/anthropic/claude-sonnet-4");
  assert.deepEqual(config.orchestrator.workflow, ["planner", "dev", "verifier"]);
  assert.equal(config.orchestrator.loops?.["verifier-fail"]?.backTo, "dev");
  assert.equal(config.triggers?.github?.repo, "acme/widget");
  assert.equal(config.mergeGate?.requireVerifierPass, true);
});

test("loader: discovers the three preset specialists with frontmatter + body", () => {
  const defs = loadSpecialists(resolve(fixtureDir, "agents"));
  assert.equal(defs.length, 3);
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(names, ["dev", "planner", "verifier"]);
  const planner = defs.find((d) => d.name === "planner")!;
  assert.ok(planner.description.length > 0);
  assert.equal(planner.model, "openrouter/anthropic/claude-sonnet-4");
  assert.ok(planner.systemPrompt.length > 0);
  assert.ok(planner.tools?.includes("read"));
  assert.equal(planner.source, "project");
});

test("workflow: loads steps, loops, merge gate, and renders rails text", () => {
  const config = loadConfig(fixtureDir);
  const wf = loadWorkflow(config);
  assert.deepEqual(wf.steps, ["planner", "dev", "verifier"]);
  assert.equal(wf.loops["verifier-fail"]?.maxRetries, 2);
  assert.equal(wf.mergeGate.autoMerge, true);
  assert.equal(wf.maxIterations, 6);
  const text = describeWorkflow(wf);
  assert.match(text, /planner → dev → verifier/);
  assert.match(text, /verifier-fail/);
});

test("loader: returns empty list for a missing agents dir", () => {
  const defs = loadSpecialists(resolve(fixtureDir, "does-not-exist"));
  assert.deepEqual(defs, []);
});
