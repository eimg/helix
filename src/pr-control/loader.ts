import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecialists } from "../agents/loader.js";
import type { SpecialistDefinition } from "../engine/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Project PR specialists win. Existing projects may reuse their legacy
 * `.helix/agents/verifier.md`; any remaining required role falls back to the
 * shipped read-only PR presets.
 */
export function loadPullRequestSpecialists(helixDir: string): SpecialistDefinition[] {
  const projectPr = loadSpecialists(resolve(helixDir, "pr-agents"));
  const legacy = loadSpecialists(resolve(helixDir, "agents"));
  const shipped = loadSpecialists(resolve(packageRoot, "presets", "pr-agents"));
  const definitions: SpecialistDefinition[] = [];

  for (const name of ["reviewer", "verifier"]) {
    const definition =
      projectPr.find((item) => item.name === name) ??
      legacy.find((item) => item.name === name) ??
      shipped.find((item) => item.name === name);
    if (definition) definitions.push(definition);
  }
  return definitions;
}
