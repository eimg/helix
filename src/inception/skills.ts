/**
 * Resolve bootstrap (inception) skills for inventory, workspace status, and
 * session loaders. Project `.helix/inception-skills/` wins; package presets
 * fill in when the project pack is empty.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAdditionalSkillPaths } from "../agents/loaderBuilder.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type InceptionSkillSource = "project" | "built_in";

export interface ResolvedInceptionSkill {
  name: string;
  relativePath: string;
  source: InceptionSkillSource;
}

/**
 * Effective bootstrap skills that inception sessions will load.
 * When the project pack exists and has entries, only project skills are listed
 * (source `project`). Otherwise package presets are listed as `built_in`.
 */
export function resolveInceptionSkills(helixDir: string): ResolvedInceptionSkill[] {
  const paths = resolveAdditionalSkillPaths(helixDir, "inception");
  if (paths.length === 0) return [];

  const root = paths[0]!;
  const projectRoot = resolve(helixDir, "inception-skills");
  const source: InceptionSkillSource = root === projectRoot ? "project" : "built_in";
  const relativeRoot = source === "project" ? "inception-skills" : "presets/inception-skills";

  return listSkillNames(root).map((name) => ({
    name,
    relativePath: join(relativeRoot, name, "SKILL.md"),
    source,
  }));
}

export function shippedInceptionSkillsDir(): string {
  return resolve(packageRoot, "presets", "inception-skills");
}

function listSkillNames(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(skillsDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
