import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  HELIX_MODEL_ENV,
  applyEnvModelToSpecialists,
  loadProjectEnv,
  parseEnvFile,
} from "../src/config/env.js";
import { loadSpecialists } from "../src/agents/loader.js";

test("parseEnvFile: parses assignments, quotes, comments, and export", () => {
  const parsed = parseEnvFile(`
# comment
OPENROUTER_API_KEY=sk-or-test
export HELIX_MODEL="openrouter/anthropic/claude-sonnet-4"
EMPTY=
QUOTED='single quoted'
  `);

  assert.equal(parsed.OPENROUTER_API_KEY, "sk-or-test");
  assert.equal(parsed.HELIX_MODEL, "openrouter/anthropic/claude-sonnet-4");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.QUOTED, "single quoted");
});

test("loadProjectEnv: loads .env into process.env without overriding existing", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-env-"));
  writeFileSync(
    join(dir, ".env"),
    `OPENROUTER_API_KEY=from-dotenv\nHELIX_MODEL=openrouter/test/model\n`
  );

  const priorKey = process.env.OPENROUTER_API_KEY;
  const priorModel = process.env[HELIX_MODEL_ENV];
  process.env.OPENROUTER_API_KEY = "from-shell";

  try {
    loadProjectEnv(dir);
    assert.equal(process.env.OPENROUTER_API_KEY, "from-shell");
    assert.equal(process.env[HELIX_MODEL_ENV], "openrouter/test/model");
  } finally {
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});

test("loadConfig: applies HELIX_MODEL from .env to orchestrator", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-env-cfg-"));
  const helixDir = join(dir, ".helix");
  mkdirSync(helixDir, { recursive: true });
  writeFileSync(join(dir, ".env"), "HELIX_MODEL=openrouter/anthropic/claude-sonnet-4\n");
  writeFileSync(
    join(helixDir, "config.json"),
    JSON.stringify({
      provider: { name: "openrouter" },
      orchestrator: { model: "openrouter/xiaomi/mimo-v2.5-pro", workflow: ["dev"] },
    })
  );

  const priorModel = process.env[HELIX_MODEL_ENV];
  delete process.env[HELIX_MODEL_ENV];

  try {
    const config = loadConfig(helixDir);
    assert.equal(config.orchestrator.model, "openrouter/anthropic/claude-sonnet-4");
  } finally {
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});

test("applyEnvModelToSpecialists: overrides specialist models when HELIX_MODEL is set", () => {
  const priorModel = process.env[HELIX_MODEL_ENV];
  process.env[HELIX_MODEL_ENV] = "openrouter/anthropic/claude-sonnet-4";

  try {
    const updated = applyEnvModelToSpecialists([
      {
        name: "dev",
        description: "dev",
        model: "openrouter/xiaomi/mimo-v2.5-pro",
        systemPrompt: "go",
        source: "project",
        filePath: "/tmp/dev.md",
      },
    ]);
    assert.equal(updated[0].model, "openrouter/anthropic/claude-sonnet-4");
  } finally {
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});

test("loadConfig + specialists: fixture unchanged when no .env present", () => {
  const fixtureDir = join(import.meta.dirname, "..", "examples", "ts", ".helix");
  const config = loadConfig(fixtureDir);
  assert.equal(config.orchestrator.model, "openrouter/xiaomi/mimo-v2.5-pro");

  const defs = applyEnvModelToSpecialists(loadSpecialists(join(fixtureDir, "agents")));
  assert.equal(defs.find((d) => d.name === "planner")?.model, "openrouter/xiaomi/mimo-v2.5-pro");
});
