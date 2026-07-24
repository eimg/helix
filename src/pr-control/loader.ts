import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecialists } from "../agents/loader.js";
import type { SpecialistDefinition } from "../engine/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type PullRequestSpecialistSource = "project" | "built_in";

export interface ResolvedPullRequestSpecialist {
  definition: SpecialistDefinition;
  source: PullRequestSpecialistSource;
}

/**
 * Project PR specialists win. Any missing required role falls back to the
 * shipped read-only PR presets. Workflow agents are deliberately ignored:
 * verification belongs only to PR control.
 */
export function resolvePullRequestSpecialists(helixDir: string): ResolvedPullRequestSpecialist[] {
  const projectPr = loadSpecialists(resolve(helixDir, "pr-agents"));
  const shipped = loadSpecialists(resolve(packageRoot, "presets", "pr-agents"));
  const definitions: ResolvedPullRequestSpecialist[] = [];

  for (const name of ["reviewer", "verifier"]) {
    const projectDefinition = projectPr.find((item) => item.name === name);
    const builtInDefinition = shipped.find((item) => item.name === name);
    if (projectDefinition) definitions.push({ definition: projectDefinition, source: "project" });
    else if (builtInDefinition) definitions.push({ definition: builtInDefinition, source: "built_in" });
  }
  return definitions;
}

export function loadPullRequestSpecialists(helixDir: string): SpecialistDefinition[] {
  return resolvePullRequestSpecialists(helixDir).map((item) => item.definition);
}
