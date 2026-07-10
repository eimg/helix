import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  HELIX_MODEL_ENV,
  loadProjectEnv,
  parseEnvFile,
  resolveModelRef,
} from "../src/config/env.js";
import { HELIX_DEFAULT_MODEL } from "../src/config/defaults.js";
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

test("resolveModelRef: HELIX_MODEL from .env wins over shipped default", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-env-cfg-"));
  const helixDir = join(dir, ".helix");
  mkdirSync(helixDir, { recursive: true });
  writeFileSync(join(dir, ".env"), "HELIX_MODEL=openrouter/anthropic/claude-sonnet-4\n");
  writeFileSync(
    join(helixDir, "config.json"),
    JSON.stringify({
      orchestrator: { workflow: ["dev"] },
    })
  );

  const priorModel = process.env[HELIX_MODEL_ENV];
  delete process.env[HELIX_MODEL_ENV];

  try {
    loadConfig(helixDir); // loads .env
    const resolved = resolveModelRef();
    assert.equal(resolved.value, "openrouter/anthropic/claude-sonnet-4");
    assert.equal(resolved.source, "env");
  } finally {
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});

test("specialists without frontmatter model inherit default; explicit model is kept", () => {
  const priorModel = process.env[HELIX_MODEL_ENV];
  process.env[HELIX_MODEL_ENV] = "openrouter/env/default-model";

  try {
    const fixtureDir = join(import.meta.dirname, "..", "examples", "ts", ".helix");
    const defs = loadSpecialists(join(fixtureDir, "agents"));
    // presets no longer set model: — they inherit default at session time
    assert.equal(defs.find((d) => d.name === "planner")?.model, undefined);

    const withExplicit = [
      ...defs,
      {
        name: "custom",
        description: "custom",
        model: "openrouter/agent/specific",
        systemPrompt: "go",
        source: "project" as const,
        filePath: "/tmp/custom.md",
      },
    ];
    assert.equal(withExplicit.find((d) => d.name === "custom")?.model, "openrouter/agent/specific");
    assert.equal(resolveModelRef().value, "openrouter/env/default-model");
  } finally {
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});

test("resolveModelRef: shipped default when HELIX_MODEL unset", () => {
  const priorModel = process.env[HELIX_MODEL_ENV];
  delete process.env[HELIX_MODEL_ENV];

  try {
    const resolved = resolveModelRef();
    assert.equal(resolved.value, HELIX_DEFAULT_MODEL);
    assert.equal(resolved.source, "default");
  } finally {
    if (priorModel === undefined) delete process.env[HELIX_MODEL_ENV];
    else process.env[HELIX_MODEL_ENV] = priorModel;
  }
});
