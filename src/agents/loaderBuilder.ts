/**
 * Builds the pi `DefaultResourceLoader` for Helix sessions (specialists +
 * orchestrator), centralizing the isolation contract.
 *
 * Contract:
 * - `.helix/skills/` (repo-local) are ALWAYS loaded into specialist sessions.
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
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface SessionLoaderOptions {
  /** Working directory (the repo root). */
  cwd: string;
  /** `.helix/` dir of the repo. */
  helixDir: string;
  /** Repo-local extension config (default disabled). */
  extensions?: { enabled?: boolean; paths?: string[] };
  /** Override the specialist's system prompt. */
  systemPromptOverride?: string;
}

export function buildSessionLoader(opts: SessionLoaderOptions): DefaultResourceLoader {
  const { cwd, helixDir, systemPromptOverride } = opts;
  const extEnabled = opts.extensions?.enabled === true;

  // Local skills: always. pi honors additionalSkillPaths even with noSkills.
  const localSkillsDir = resolve(helixDir, "skills");
  const additionalSkillPaths = existsSync(localSkillsDir) ? [localSkillsDir] : [];

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
