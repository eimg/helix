/**
 * Path resolution for essentials fallback.
 *
 * Essentials (API key, model definitions) resolve in two steps only:
 *   1. Project `.env` / process env (always wins for the API key)
 *   2. Operator's global pi dir (`~/.pi/agent/`) — auth.json + models.json
 *
 * There is no Helix-owned `~/.helix/` secrets/models home. Repo-local
 * `.helix/` is for wiring (config, agents, skills) only.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** pi's global agent dir, as pi itself resolves it. Read-only to Helix. */
export function getPiAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? resolve(homedir(), ".pi", "agent");
}

export interface PathResolution {
  /** `~/.pi/agent/auth.json` — credential store fallback when env key is unset. */
  readonly piAuthFile: string;
  /** `~/.pi/agent/models.json` — model defs fallback. */
  readonly piModelsFile: string;
  /** `~/.pi/agent` — used only for path display / optional PI_AGENT_DIR override. */
  readonly piAgentDir: string;
}

export function resolvePaths(): PathResolution {
  const pi = getPiAgentDir();
  return {
    piAuthFile: resolve(pi, "auth.json"),
    piModelsFile: resolve(pi, "models.json"),
    piAgentDir: pi,
  };
}

/** Return pi auth.json if it exists. */
export function resolveAuthFile(paths: PathResolution = resolvePaths()): string | undefined {
  if (existsSync(paths.piAuthFile)) return paths.piAuthFile;
  return undefined;
}

/** Return pi models.json if it exists; otherwise undefined (built-in models). */
export function resolveModelsFile(paths: PathResolution = resolvePaths()): string | undefined {
  if (existsSync(paths.piModelsFile)) return paths.piModelsFile;
  return undefined;
}
