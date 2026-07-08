/**
 * Helix "home" + config-path resolution.
 *
 * Helix owns `~/.helix/` (overridable via `HELIX_CONFIG_DIR`). It is distinct
 * from pi's `~/.pi/agent/`. The two only meet through the `inheritPi` toggle:
 * when `inheritPi` is false (the default), Helix never reads `~/.pi/` at all —
 * not for secrets, not for models, not for skills/extensions. When true, pi's
 * global dir is used as a read-only last-resort fallback (for both secrets and
 * model definitions) and pi's default skill/extension discovery is enabled.
 *
 * Local repo resources (`.helix/skills/`, `.helix/agents/`) are ALWAYS loaded,
 * regardless of `inheritPi` — they are the point of the project.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The Helix home directory: `~/.helix/` unless `HELIX_CONFIG_DIR` is set. */
export function getHelixHome(): string {
  return process.env.HELIX_CONFIG_DIR ?? resolve(homedir(), ".helix");
}

/** pi's global agent dir, as pi itself resolves it. Read-only to Helix. */
export function getPiAgentDir(): string {
  // Defer the import so this module stays usable in tests without pi fully
  // wired, and to avoid pulling pi into the config-pure path.
  // (getAgentDir is re-exported from the main entry.)
  // We mirror pi's own resolution: ~/.pi/agent unless PI_AGENT_DIR is set.
  return process.env.PI_AGENT_DIR ?? resolve(homedir(), ".pi", "agent");
}

export interface PathResolution {
  /** `~/.helix/secrets.json` — Helix-owned credential store. */
  readonly helixSecretsFile: string;
  /** `~/.helix/models.json` — Helix-owned model/provider definitions. */
  readonly helixModelsFile: string;
  /** `~/.pi/agent/auth.json` — pi's credential store (read-only fallback). */
  readonly piAuthFile: string;
  /** `~/.pi/agent/models.json` — pi's model defs (read-only fallback). */
  readonly piModelsFile: string;
  /** `~/.pi/agent` — pi's global dir, used for skill/extension/settings inheritance. */
  readonly piAgentDir: string;
}

export function resolvePaths(): PathResolution {
  const home = getHelixHome();
  const pi = getPiAgentDir();
  return {
    helixSecretsFile: resolve(home, "secrets.json"),
    helixModelsFile: resolve(home, "models.json"),
    piAuthFile: resolve(pi, "auth.json"),
    piModelsFile: resolve(pi, "models.json"),
    piAgentDir: pi,
  };
}

/**
 * Resolve the auth file to pass to pi's `AuthStorage.create(path)`.
 *
 * First existing file wins:
 *   1. `~/.helix/secrets.json`   (Helix-owned)
 *   2. `~/.pi/agent/auth.json`   (pi fallback — ONLY if inheritPi)
 *
 * Returns `undefined` if no file exists (the provider then relies on the env
 * var / runtime override). Secrets are NEVER written to a fallback source.
 */
export function resolveAuthFile(inheritPi: boolean, paths: PathResolution = resolvePaths()): string | undefined {
  if (existsSync(paths.helixSecretsFile)) return paths.helixSecretsFile;
  if (inheritPi && existsSync(paths.piAuthFile)) return paths.piAuthFile;
  return undefined;
}

/**
 * Resolve the models.json path to pass to pi's `ModelRegistry.create(auth, path)`.
 *
 *   1. `~/.helix/models.json`     (Helix-owned)
 *   2. `~/.pi/agent/models.json`  (pi fallback — ONLY if inheritPi)
 *
 * Returns `undefined` to use pi's built-in models only.
 */
export function resolveModelsFile(inheritPi: boolean, paths: PathResolution = resolvePaths()): string | undefined {
  if (existsSync(paths.helixModelsFile)) return paths.helixModelsFile;
  if (inheritPi && existsSync(paths.piModelsFile)) return paths.piModelsFile;
  return undefined;
}
