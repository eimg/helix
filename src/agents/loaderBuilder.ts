/**
 * Builds the pi `DefaultResourceLoader` for Helix sessions (specialists +
 * orchestrator), centralizing the isolation + inheritance contract.
 *
 * Contract:
 * - `.helix/skills/` (repo-local) are ALWAYS loaded into specialist sessions.
 * - `.helix/agents/` is loaded by Helix itself (not pi).
 * - Global pi skills/extensions/context/themes/prompts are loaded ONLY when
 *   `inheritPi` is true. Otherwise the session is isolated: system prompt +
 *   built-in tools + repo-local skills, nothing inherited.
 * - Repo-local extensions (`.helix/extensions/` + config paths) load only when
 *   `extensions.enabled` is true. OFF by default.
 *
 * `additionalSkillPaths` are honored by pi REGARDLESS of `noSkills`, which is
 * exactly what lets local skills always load while global discovery is gated.
 */
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { getPiAgentDir } from "../config/paths.js";

export interface SessionLoaderOptions {
  /** Working directory (the repo root). */
  cwd: string;
  /** `.helix/` dir of the repo. */
  helixDir: string;
  /** Inherit global pi config (skills/extensions/settings). Default false. */
  inheritPi?: boolean;
  /** Repo-local extension config (default disabled). */
  extensions?: { enabled?: boolean; paths?: string[] };
  /** Override the specialist's system prompt. */
  systemPromptOverride?: string;
}

export function buildSessionLoader(opts: SessionLoaderOptions): DefaultResourceLoader {
  const { cwd, helixDir, systemPromptOverride } = opts;
  const inheritPi = opts.inheritPi ?? false;
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
    // agentDir: only point at pi's dir when inheriting. Otherwise use the
    // helixDir itself (harmless: pi looks for extensions/skills/prompts/themes
    // under it, and we gate those with no* flags below).
    agentDir: inheritPi ? getPiAgentDir() : helixDir,
    additionalSkillPaths,
    additionalExtensionPaths,
    // Global pi discovery — gated by inheritPi. Local additional paths still load.
    noExtensions: !inheritPi && !extEnabled,
    noSkills: !inheritPi,
    noContextFiles: !inheritPi,
    noThemes: !inheritPi,
    noPromptTemplates: !inheritPi,
    systemPromptOverride: systemPromptOverride !== undefined ? () => systemPromptOverride : undefined,
  });
  return loader;
}
