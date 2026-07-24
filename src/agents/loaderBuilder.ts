/**
 * Builds the pi `DefaultResourceLoader` for Helix sessions (specialists +
 * orchestrator), centralizing the isolation contract.
 *
 * Contract:
 * - Run / PR / Manage sessions load `.helix/skills/` when present.
 * - Bootstrap (inception) sessions load `.helix/inception-skills/` when present,
 *   else fall back to package `presets/inception-skills/`.
 * - `.helix/agents/` is loaded by Helix itself (not pi).
 * - Global pi skills/extensions/context/themes/prompts are NEVER loaded —
 *   sessions stay isolated. Auth/models may still come from pi (essentials);
 *   that is separate from session resource inheritance.
 * - Repo-local extensions (`.helix/extensions/` + config paths) load only when
 *   `extensions.enabled` is true. OFF by default.
 *
 * `additionalSkillPaths` are honored by pi REGARDLESS of `noSkills`, which is
 * exactly what lets local skills always load while global discovery is off.
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Which skill directory family a session should load. */
export type SkillPack = "run" | "inception";

export interface SessionLoaderOptions {
  /** Working directory (the repo root). */
  cwd: string;
  /** `.helix/` dir of the repo. */
  helixDir: string;
  /**
   * Skill pack for this session. Default `run` (`.helix/skills`).
   * Use `inception` for bootstrap specialists (`.helix/inception-skills`).
   */
  skillPack?: SkillPack;
  /** Repo-local extension config (default disabled). */
  extensions?: { enabled?: boolean; paths?: string[] };
  /** Override the specialist's system prompt. */
  systemPromptOverride?: string;
}

/**
 * Resolve skill directories for a session. Inception prefers project
 * `inception-skills/`; if that folder has no skills yet, fall back to package presets.
 */
export function resolveAdditionalSkillPaths(
  helixDir: string,
  skillPack: SkillPack = "run",
): string[] {
  if (skillPack === "run") {
    const dir = resolve(helixDir, "skills");
    return existsSync(dir) ? [dir] : [];
  }

  const project = resolve(helixDir, "inception-skills");
  if (skillDirHasEntries(project)) return [project];

  const shipped = resolve(packageRoot, "presets", "inception-skills");
  return skillDirHasEntries(shipped) ? [shipped] : [];
}

export function buildSessionLoader(opts: SessionLoaderOptions): DefaultResourceLoader {
  const { cwd, helixDir, systemPromptOverride } = opts;
  const extEnabled = opts.extensions?.enabled === true;
  const skillPack = opts.skillPack ?? "run";

  const additionalSkillPaths = resolveAdditionalSkillPaths(helixDir, skillPack);

  // Repo-local extensions (only when explicitly enabled).
  const additionalExtensionPaths: string[] = [];
  if (extEnabled) {
    const localExtDir = resolve(helixDir, "extensions");
    if (existsSync(localExtDir)) additionalExtensionPaths.push(localExtDir);
    for (const p of opts.extensions?.paths ?? []) additionalExtensionPaths.push(p);
  }

  const loader = new DefaultResourceLoader({
    cwd,
    // Point agentDir at helixDir (harmless): pi looks for extensions/skills/
    // prompts/themes under it, and we gate those with no* flags below.
    agentDir: helixDir,
    additionalSkillPaths,
    additionalExtensionPaths,
    noExtensions: !extEnabled,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    systemPromptOverride: systemPromptOverride !== undefined ? () => systemPromptOverride : undefined,
  });
  return loader;
}

function skillDirHasEntries(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, "SKILL.md")),
    );
  } catch {
    return false;
  }
}
