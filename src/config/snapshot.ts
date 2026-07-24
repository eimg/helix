/**
 * Read-only observability snapshot of the active Helix runtime config.
 *
 * Essentials resolve in two steps: `.env` / process env, then the operator's
 * global pi install. `.helix/config.json` is wiring only (workflow, gates, …).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HelixConfig } from "../config.js";
import { githubPrEnabled, localPrEnabled } from "../config.js";
import { OPENROUTER_API_KEY_ENV } from "./defaults.js";
import { HELIX_MODEL_ENV, resolveModelRef, repoRootFromHelixDir } from "./env.js";
import {
  getPiAgentDir,
  resolveAuthFile,
  resolveModelsFile,
  resolvePaths,
  type PathResolution,
} from "./paths.js";
import { DEFAULT_CONTEXT_FILES } from "../context/bootstrap.js";
import type { RunContext } from "../run/bootstrap.js";
import type { SpecialistDefinition } from "../engine/types.js";
import { loadManageInventory } from "../manage/inventory.js";

export type ConfigSource =
  | "env"
  | "default"
  | "agent"
  | "pi"
  | "built_in"
  | "none";

export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
  /** Human-readable detail (env var name, file path, etc.). */
  detail?: string;
}

export interface ConfigSnapshot {
  paths: {
    helixDir: string;
    cwd: string;
    piAgentDir: string;
    envFile: string;
    envFileExists: boolean;
  };
  provider: {
    name: string;
    apiKeyEnv: string;
    authConfigured: boolean;
    authSource: ConfigSource;
    authDetail?: string;
    modelsFile: ResolvedValue<string | null>;
  };
  models: {
    orchestrator: ResolvedValue<string>;
    helixModelEnvSet: boolean;
    specialists: Array<{
      name: string;
      model: ResolvedValue<string | null>;
      description: string;
      inWorkflow: boolean;
    }>;
    prSpecialists: Array<{
      name: string;
      model: ResolvedValue<string | null>;
      description: string;
      definitionSource: "project" | "built_in";
    }>;
  };
  flags: {
    extensionsEnabled: boolean;
    extensionPaths: string[];
    repoContextEnabled: boolean;
    deliverablePr: boolean;
    deliverableLocalPr: boolean;
  };
  workflow: {
    steps: string[];
    maxIterations: number;
  };
  mergeGate: HelixConfig["mergeGate"];
  triggers: HelixConfig["triggers"];
  repoContext: {
    enabled: boolean;
    files: string[];
  };
  resources: {
    skills: Array<{ name: string; relativePath: string }>;
    agentsDir: string;
    prAgentsDir: string;
    skillsDir: string;
  };
  /** Raw merged wiring config (no secrets). */
  config: HelixConfig;
}

export function buildConfigSnapshot(ctx: RunContext): ConfigSnapshot {
  const paths = resolvePaths();
  const envFile = resolve(repoRootFromHelixDir(ctx.helixDir), ".env");
  const helixModelEnvSet = Boolean(process.env[HELIX_MODEL_ENV]?.trim());
  const resolvedModel = resolveModelRef();

  const auth = resolveAuthSource(paths);
  const modelsFilePath = resolveModelsFile(paths);
  const modelsFile: ResolvedValue<string | null> = modelsFilePath
    ? {
        value: modelsFilePath,
        source: "pi",
        detail: modelsFilePath,
      }
    : {
        value: null,
        source: "built_in",
        detail: "pi built-in models (no models.json)",
      };

  const inventory = loadManageInventory(ctx.helixDir);
  const workflowSteps = ctx.config.orchestrator.workflow;
  const workflowSet = new Set(workflowSteps);

  return {
    paths: {
      helixDir: ctx.helixDir,
      cwd: ctx.cwd,
      piAgentDir: getPiAgentDir(),
      envFile,
      envFileExists: existsSync(envFile),
    },
    provider: {
      name: "openrouter",
      apiKeyEnv: OPENROUTER_API_KEY_ENV,
      authConfigured: ctx.provider.hasAuth(),
      authSource: auth.source,
      authDetail: auth.detail,
      modelsFile,
    },
    models: {
      orchestrator: {
        value: ctx.model,
        source: resolvedModel.source,
        detail: resolvedModel.detail,
      },
      helixModelEnvSet,
      specialists: ctx.specialists.map((s) => specialistModelRow(s, resolvedModel, workflowSet)),
      prSpecialists: inventory.prAgents.map((specialist) => ({
        name: specialist.name,
        model: specialist.model
          ? {
              value: specialist.model,
              source: "agent",
              detail: specialist.relativePath,
            }
          : {
              value: resolvedModel.value,
              source: resolvedModel.source,
              detail: resolvedModel.detail,
            },
        description: specialist.description,
        definitionSource: specialist.source,
      })),
    },
    flags: {
      extensionsEnabled: ctx.config.extensions?.enabled === true,
      extensionPaths: [
        resolve(ctx.helixDir, "extensions"),
        ...(ctx.config.extensions?.paths ?? []),
      ],
      repoContextEnabled: ctx.config.repoContext?.enabled !== false,
      deliverablePr: githubPrEnabled(ctx.config),
      deliverableLocalPr: localPrEnabled(ctx.config),
    },
    workflow: {
      steps: workflowSteps,
      maxIterations: ctx.workflow.maxIterations,
    },
    mergeGate: ctx.config.mergeGate,
    triggers: ctx.config.triggers,
    repoContext: {
      enabled: ctx.config.repoContext?.enabled !== false,
      files: ctx.config.repoContext?.files ?? [
        ...DEFAULT_CONTEXT_FILES,
        ".helix/context/*.md",
      ],
    },
    resources: {
      skills: inventory.skills,
      agentsDir: resolve(ctx.helixDir, "agents"),
      prAgentsDir: resolve(ctx.helixDir, "pr-agents"),
      skillsDir: resolve(ctx.helixDir, "skills"),
    },
    config: ctx.config,
  };
}

function specialistModelRow(
  s: SpecialistDefinition,
  defaultResolved: ReturnType<typeof resolveModelRef>,
  workflowSet: Set<string>
): ConfigSnapshot["models"]["specialists"][number] {
  if (s.model) {
    return {
      name: s.name,
      model: {
        value: s.model,
        source: "agent",
        detail: s.filePath,
      },
      description: s.description,
      inWorkflow: workflowSet.has(s.name),
    };
  }
  return {
    name: s.name,
    model: {
      value: defaultResolved.value,
      source: defaultResolved.source,
      detail: defaultResolved.detail,
    },
    description: s.description,
    inWorkflow: workflowSet.has(s.name),
  };
}

function resolveAuthSource(paths: PathResolution): { source: ConfigSource; detail?: string } {
  if (process.env[OPENROUTER_API_KEY_ENV]) {
    return { source: "env", detail: OPENROUTER_API_KEY_ENV };
  }
  const authFile = resolveAuthFile(paths);
  if (authFile) {
    return { source: "pi", detail: authFile };
  }
  return { source: "none", detail: "no API key configured" };
}
