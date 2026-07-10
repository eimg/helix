import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthFile, resolveModelsFile, resolvePaths, getPiAgentDir } from "../src/config/paths.js";

function fakePaths(dir: string) {
  return {
    piAuthFile: join(dir, "auth.json"),
    piModelsFile: join(dir, "models.json"),
    piAgentDir: dir,
  };
}

test("resolveAuthFile: returns pi auth when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-paths-auth-"));
  writeFileSync(join(dir, "auth.json"), "{}");
  const paths = fakePaths(dir);
  assert.equal(resolveAuthFile(paths), paths.piAuthFile);
});

test("resolveAuthFile: returns undefined when pi auth missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-paths-noauth-"));
  assert.equal(resolveAuthFile(fakePaths(dir)), undefined);
});

test("resolveModelsFile: returns pi models when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-paths-models-"));
  writeFileSync(join(dir, "models.json"), "{}");
  const paths = fakePaths(dir);
  assert.equal(resolveModelsFile(paths), paths.piModelsFile);
});

test("resolveModelsFile: returns undefined when pi models missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-paths-nomodels-"));
  assert.equal(resolveModelsFile(fakePaths(dir)), undefined);
});

test("resolvePaths: honors PI_AGENT_DIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-paths-env-"));
  const old = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = dir;
  try {
    const paths = resolvePaths();
    assert.equal(paths.piAgentDir, dir);
    assert.equal(paths.piAuthFile, join(dir, "auth.json"));
    assert.equal(getPiAgentDir(), dir);
  } finally {
    if (old === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = old;
  }
});
