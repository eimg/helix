/**
 * Loads + validates `.helix/config.json`.
 *
 * v1 schema is intentionally small. We extend it as features land.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface HelixConfig {
  provider: {
    name: "openrouter";
    apiKeyEnv?: string; // default OPENROUTER_API_KEY
    defaultModel?: string;
  };
  orchestrator: {
    model: string;
    workflow: string[]; // specialist names, default order
    maxIterations?: number;
    loops?: Record<string, { backTo: string; maxRetries: number }>;
  };
  triggers?: {
    github?: {
      repo: string;
      labelFilter?: string;
      mode?: "poll" | "webhook"; // v1: poll
      intervalSec?: number;
    };
  };
  mergeGate?: {
    autoMerge?: boolean;
    maxDiffLines?: number;
    maxFiles?: number;
    requireVerifierPass?: boolean;
  };
}

const DEFAULTS: Partial<HelixConfig> = {
  orchestrator: { model: "", workflow: ["planner", "dev", "verifier"], maxIterations: 6 },
};

export function loadConfig(helixDir = resolve(process.cwd(), ".helix")): HelixConfig {
  const raw = readFileSync(resolve(helixDir, "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<HelixConfig>;
  const config: HelixConfig = {
    provider: parsed.provider ?? { name: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    orchestrator: {
      model: parsed.orchestrator?.model ?? DEFAULTS.orchestrator!.model!,
      workflow: parsed.orchestrator?.workflow ?? DEFAULTS.orchestrator!.workflow!,
      maxIterations: parsed.orchestrator?.maxIterations ?? DEFAULTS.orchestrator!.maxIterations,
      loops: parsed.orchestrator?.loops,
    },
    triggers: parsed.triggers,
    mergeGate: parsed.mergeGate,
  };

  if (!config.provider.name) throw new Error("config: provider.name is required");
  if (!config.orchestrator.model) throw new Error("config: orchestrator.model is required (e.g. openrouter/anthropic/claude-sonnet-4)");
  if (config.orchestrator.workflow.length === 0) throw new Error("config: orchestrator.workflow must list at least one specialist");

  return config;
}
