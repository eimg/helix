/**
 * Project-local `.env` loading + model resolution for Helix.
 *
 * Loaded from the repo root (parent of `.helix/`). Values are applied to
 * `process.env` only when not already set — shell exports win.
 *
 * Default model: `HELIX_MODEL` in env, else the shipped Helix default.
 * Used for orchestrator, manage, and any specialist without frontmatter `model:`.
 * A specialist's own `model:` always wins over the default.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HELIX_DEFAULT_MODEL } from "./defaults.js";

export const HELIX_MODEL_ENV = "HELIX_MODEL";

export type ModelSource = "env" | "default";

export interface ResolvedModel {
  value: string;
  source: ModelSource;
  detail: string;
}

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

/**
 * Resolve the active default model (orchestrator, manage, and specialists
 * without their own frontmatter model).
 * `HELIX_MODEL` wins; otherwise the shipped Helix default.
 */
export function resolveModelRef(): ResolvedModel {
  const fromEnv = process.env[HELIX_MODEL_ENV]?.trim();
  if (fromEnv) {
    return { value: fromEnv, source: "env", detail: HELIX_MODEL_ENV };
  }
  return {
    value: HELIX_DEFAULT_MODEL,
    source: "default",
    detail: "Helix shipped default (set HELIX_MODEL in .env to override)",
  };
}
