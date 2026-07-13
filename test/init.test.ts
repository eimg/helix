import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, listPresets } from "../src/init.js";

function withTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-init-"));
  process.chdir(dir);
  return dir;
}

test("init: scaffolds .helix/ with config + 3 agents + typescript skill", () => {
  const dir = withTempCwd();
  init({});

  assert.ok(existsSync(join(dir, ".helix", "config.json")));
  assert.ok(existsSync(join(dir, ".helix", "agents", "planner.md")));
  assert.ok(existsSync(join(dir, ".helix", "agents", "dev.md")));
  assert.ok(existsSync(join(dir, ".helix", "agents", "verifier.md")));
  assert.ok(existsSync(join(dir, ".helix", "skills", "typescript", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".helix", "runs")));
  assert.ok(existsSync(join(dir, ".env.example")));

  const config = JSON.parse(readFileSync(join(dir, ".helix", "config.json"), "utf-8"));
  assert.deepEqual(config.orchestrator.workflow, ["planner", "dev", "verifier"]);
  assert.ok(!config.provider);
  assert.ok(!config.inheritPi);
  assert.ok(!config.orchestrator.model);

  const envExample = readFileSync(join(dir, ".env.example"), "utf-8");
  assert.match(envExample, /OPENROUTER_API_KEY/);
  assert.match(envExample, /HELIX_MODEL=/);
});

test("init: writes .gitignore with .helix/runs/ and .env", () => {
  const dir = withTempCwd();
  init({});
  const gi = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.match(gi, /\.helix\/runs\//);
  assert.match(gi, /^\.env$/m);
});

test("init: refuses to overwrite existing config without --force", () => {
  withTempCwd();
  init({});
  assert.throws(() => init({}), /already exists/);
});

test("init: --force overwrites config", () => {
  withTempCwd();
  init({});
  // should not throw
  init({ force: true });
});

test("init: --preset express writes express skill", () => {
  const dir = withTempCwd();
  init({ preset: "express", force: true });
  assert.ok(existsSync(join(dir, ".helix", "skills", "express", "SKILL.md")));
});

test("init: bad preset exits with error", () => {
  withTempCwd();
  assert.throws(() => init({ preset: "nope" }), /Unknown preset/);
});

test("init: listPresets returns all 5 stacks", () => {
  const presets = listPresets();
  assert.deepEqual(presets.sort(), ["expo", "express", "laravel", "livewire", "php", "react", "react-native", "typescript"]);
});
