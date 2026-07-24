import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecialists } from "../agents/loader.js";
import type { SpecialistDefinition } from "../engine/types.js";
import { DEFAULT_INCEPTION_ROLES, type InceptionRole } from "./roles.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type InceptionSpecialistSource = "project" | "built_in";

export interface ResolvedInceptionSpecialist {
  definition: SpecialistDefinition;
  source: InceptionSpecialistSource;
  role: InceptionRole;
}

/**
 * Project inception specialists win. Missing fixed roles fall back to shipped
 * presets. Workflow and PR agents are ignored — inception is its own lane.
 */
export function resolveInceptionSpecialists(
  helixDir: string,
  roleOrder: readonly InceptionRole[] = DEFAULT_INCEPTION_ROLES,
): ResolvedInceptionSpecialist[] {
  const project = loadSpecialists(resolve(helixDir, "inception-agents"));
  const shipped = loadSpecialists(resolve(packageRoot, "presets", "inception-agents"));
  const definitions: ResolvedInceptionSpecialist[] = [];

  for (const role of roleOrder) {
    const projectDefinition = project.find((item) => item.name === role);
    const builtInDefinition = shipped.find((item) => item.name === role);
    if (projectDefinition) {
      definitions.push({ definition: projectDefinition, source: "project", role });
    } else if (builtInDefinition) {
      definitions.push({ definition: builtInDefinition, source: "built_in", role });
    }
  }
  return definitions;
}

export function loadInceptionSpecialists(
  helixDir: string,
  roleOrder?: readonly InceptionRole[],
): SpecialistDefinition[] {
  return resolveInceptionSpecialists(helixDir, roleOrder).map((item) => item.definition);
}
