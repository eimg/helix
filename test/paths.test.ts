import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAuthFile,
  resolveModelsFile,
  resolvePaths,
  type PathResolution,
} from "../src/config/paths.js";

/** Build an isolated path resolution against temp dirs. */
function withTempDirs(opts: { helix?: boolean; pi?: boolean }): PathResolution {
  const helixHome = mkdtempSync(join(tmpdir(), "helix-home-"));
  const piHome = mkdtempSync(join(tmpdir(), "pi-home-"));
  if (opts.helix) {
    writeFileSync(join(helixHome, "secrets.json"), "{}");
    writeFileSync(join(helixHome, "models.json"), "{}");
  }
  if (opts.pi) {
    mkdirSync(join(piHome, "agent"), { recursive: true });
    writeFileSync(join(piHome, "agent", "auth.json"), "{}");
    writeFileSync(join(piHome, "agent", "models.json"), "{}");
  }
  return {
    helixSecretsFile: join(helixHome, "secrets.json"),
    helixModelsFile: join(helixHome, "models.json"),
    piAuthFile: join(piHome, "agent", "auth.json"),
    piModelsFile: join(piHome, "agent", "models.json"),
    piAgentDir: join(piHome, "agent"),
  };
}

test("resolveAuthFile: returns helix secrets when present (regardless of inheritPi)", () => {
  const paths = withTempDirs({ helix: true, pi: true });
  assert.equal(resolveAuthFile(false, paths), paths.helixSecretsFile);
  assert.equal(resolveAuthFile(true, paths), paths.helixSecretsFile);
});

test("resolveAuthFile: falls back to pi auth ONLY when inheritPi is true", () => {
  const paths = withTempDirs({ helix: false, pi: true });
  assert.equal(resolveAuthFile(false, paths), undefined, "inheritPi=false must not touch ~/.pi/");
  assert.equal(resolveAuthFile(true, paths), paths.piAuthFile, "inheritPi=true falls back to pi");
});

test("resolveAuthFile: returns undefined when nothing exists", () => {
  const paths = withTempDirs({ helix: false, pi: false });
  assert.equal(resolveAuthFile(false, paths), undefined);
  assert.equal(resolveAuthFile(true, paths), undefined);
});

test("resolveModelsFile: returns helix models when present (regardless of inheritPi)", () => {
  const paths = withTempDirs({ helix: true, pi: true });
  assert.equal(resolveModelsFile(false, paths), paths.helixModelsFile);
  assert.equal(resolveModelsFile(true, paths), paths.helixModelsFile);
});

test("resolveModelsFile: falls back to pi models ONLY when inheritPi is true", () => {
  const paths = withTempDirs({ helix: false, pi: true });
  assert.equal(resolveModelsFile(false, paths), undefined);
  assert.equal(resolveModelsFile(true, paths), paths.piModelsFile);
});

test("resolvePaths: honors HELIX_CONFIG_DIR and PI_AGENT_DIR", () => {
  const helixHome = mkdtempSync(join(tmpdir(), "h-"));
  const piHome = mkdtempSync(join(tmpdir(), "p-"));
  const oldH = process.env.HELIX_CONFIG_DIR;
  const oldP = process.env.PI_AGENT_DIR;
  process.env.HELIX_CONFIG_DIR = helixHome;
  process.env.PI_AGENT_DIR = piHome;
  try {
    const p = resolvePaths();
    assert.equal(p.helixSecretsFile, join(helixHome, "secrets.json"));
    assert.equal(p.piAgentDir, piHome);
  } finally {
    if (oldH === undefined) delete process.env.HELIX_CONFIG_DIR;
    else process.env.HELIX_CONFIG_DIR = oldH;
    if (oldP === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = oldP;
  }
});
