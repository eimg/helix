/** Read and update the simple ordered workflow exposed by Manage. */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { loadManageInventory } from "./inventory.js";

export interface ManagedWorkflow {
  steps: string[];
}

export function loadManagedWorkflow(helixDir: string): ManagedWorkflow {
  return { steps: [...loadConfig(helixDir).orchestrator.workflow] };
}

export function saveManagedWorkflow(helixDir: string, requestedSteps: unknown): ManagedWorkflow {
  const steps = validateWorkflowSteps(helixDir, requestedSteps);
  const configPath = resolve(helixDir, "config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const orchestrator = isRecord(raw.orchestrator) ? raw.orchestrator : {};
  raw.orchestrator = { ...orchestrator, workflow: steps };

  // Same-directory rename makes the update atomic for new run readers.
  const temporaryPath = resolve(helixDir, `.config.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, configPath);
  return { steps };
}

function validateWorkflowSteps(helixDir: string, requestedSteps: unknown): string[] {
  if (!Array.isArray(requestedSteps)) throw new Error("steps must be an array of agent names");
  const steps = requestedSteps.map((step) => {
    if (typeof step !== "string" || !step.trim()) throw new Error("Every workflow step must be an agent name");
    return step.trim();
  });
  if (steps.length === 0) throw new Error("Workflow must contain at least one agent");

  const duplicates = steps.filter((step, index) => steps.indexOf(step) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Workflow contains duplicate agent: ${[...new Set(duplicates)].join(", ")}`);
  }

  const available = new Set(loadManageInventory(helixDir).agents.map((agent) => agent.name));
  const unknown = steps.filter((step) => !available.has(step));
  if (unknown.length > 0) throw new Error(`Unknown workflow agent: ${unknown.join(", ")}`);
  return steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
