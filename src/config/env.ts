/**
 * Project-local `.env` loading for Helix.
 *
 * Loaded from the repo root (parent of `.helix/`). Values are applied to
 * `process.env` only when not already set — shell exports win.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HelixConfig } from "../config.js";
import type { SpecialistDefinition } from "../engine/types.js";

export const HELIX_MODEL_ENV = "HELIX_MODEL";

/** Parse a dotenv-style file into key/value pairs. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/** Repo root for a `.helix/` directory. */
export function repoRootFromHelixDir(helixDir: string): string {
  return resolve(helixDir, "..");
}

/** Load `.env` from the repo root into `process.env` (non-destructive). */
export function loadProjectEnv(repoRoot: string): void {
  const envPath = resolve(repoRoot, ".env");
  if (!existsSync(envPath)) return;

  const parsed = parseEnvFile(readFileSync(envPath, "utf-8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Apply `HELIX_MODEL` to orchestrator config when set. */
export function applyEnvModelToConfig(config: HelixConfig): HelixConfig {
  const model = process.env[HELIX_MODEL_ENV]?.trim();
  if (!model) return config;
  return {
    ...config,
    orchestrator: { ...config.orchestrator, model },
  };
}

/** Apply `HELIX_MODEL` to specialist definitions when set. */
export function applyEnvModelToSpecialists(specialists: SpecialistDefinition[]): SpecialistDefinition[] {
  const model = process.env[HELIX_MODEL_ENV]?.trim();
  if (!model) return specialists;
  return specialists.map((s) => ({ ...s, model }));
}
