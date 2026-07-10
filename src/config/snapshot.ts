/**
 * Read-only observability snapshot of the active Helix runtime config.
 *
 * Surfaces what is actually in effect after multi-level resolution
 * (env → ~/.helix → ~/.pi when inheritPi → repo `.helix/config.json`),
 * without exposing secret values.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HelixConfig } from "../config.js";
import { githubPrEnabled } from "../config.js";
import { HELIX_MODEL_ENV, repoRootFromHelixDir } from "./env.js";
import {
  getHelixHome,
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
  | "config"
  | "agent"
  | "helix_home"
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
    helixHome: string;
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
  };
  flags: {
    inheritPi: boolean;
    extensionsEnabled: boolean;
    extensionPaths: string[];
    repoContextEnabled: boolean;
    deliverablePr: boolean;
  };
  workflow: {
    steps: string[];
    maxIterations: number;
    loops: Record<string, { backTo: string; maxRetries: number }>;
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
    skillsDir: string;
  };
  /** Raw merged config (no secrets). Useful for operators who want the full object. */
  config: HelixConfig;
}

export function buildConfigSnapshot(ctx: RunContext): ConfigSnapshot {
  const paths = resolvePaths();
  const apiKeyEnv = ctx.config.provider.apiKeyEnv ?? "OPENROUTER_API_KEY";
  const inheritPi = ctx.config.inheritPi === true;
  const envFile = resolve(repoRootFromHelixDir(ctx.helixDir), ".env");
  const helixModelEnvSet = Boolean(process.env[HELIX_MODEL_ENV]?.trim());

  const auth = resolveAuthSource(apiKeyEnv, inheritPi, paths);
  const modelsFilePath = resolveModelsFile(inheritPi, paths);
  const modelsFile: ResolvedValue<string | null> = modelsFilePath
    ? {
        value: modelsFilePath,
        source: modelsFilePath === paths.helixModelsFile ? "helix_home" : "pi",
        detail: modelsFilePath,
      }
    : {
        value: null,
        source: "built_in",
        detail: inheritPi ? "pi built-in models" : "in-memory / built-in (no models.json)",
      };

  const inventory = loadManageInventory(ctx.helixDir);
  const workflowSteps = ctx.config.orchestrator.workflow;
  const workflowSet = new Set(workflowSteps);

  return {
    paths: {
      helixDir: ctx.helixDir,
      cwd: ctx.cwd,
      helixHome: getHelixHome(),
      piAgentDir: getPiAgentDir(),
      envFile,
      envFileExists: existsSync(envFile),
    },
    provider: {
      name: ctx.config.provider.name,
      apiKeyEnv,
      authConfigured: ctx.provider.hasAuth(),
      authSource: auth.source,
      authDetail: auth.detail,
      modelsFile,
    },
    models: {
      orchestrator: {
        value: ctx.config.orchestrator.model,
        source: helixModelEnvSet ? "env" : "config",
        detail: helixModelEnvSet ? HELIX_MODEL_ENV : ".helix/config.json",
      },
      helixModelEnvSet,
      specialists: ctx.specialists.map((s) => specialistModelRow(s, helixModelEnvSet, workflowSet)),
    },
    flags: {
      inheritPi,
      extensionsEnabled: ctx.config.extensions?.enabled === true,
      extensionPaths: [
        resolve(ctx.helixDir, "extensions"),
        ...(ctx.config.extensions?.paths ?? []),
      ],
      repoContextEnabled: ctx.config.repoContext?.enabled !== false,
      deliverablePr: githubPrEnabled(ctx.config),
    },
    workflow: {
      steps: workflowSteps,
      maxIterations: ctx.workflow.maxIterations,
      loops: ctx.config.orchestrator.loops ?? {},
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
      skillsDir: resolve(ctx.helixDir, "skills"),
    },
    config: ctx.config,
  };
}

function specialistModelRow(
  s: SpecialistDefinition,
  helixModelEnvSet: boolean,
  workflowSet: Set<string>
): ConfigSnapshot["models"]["specialists"][number] {
  if (helixModelEnvSet) {
    return {
      name: s.name,
      model: {
        value: s.model ?? null,
        source: "env",
        detail: HELIX_MODEL_ENV,
      },
      description: s.description,
      inWorkflow: workflowSet.has(s.name),
    };
  }
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
      value: null,
      source: "none",
      detail: "no model in agent frontmatter (orchestrator / provider default)",
    },
    description: s.description,
    inWorkflow: workflowSet.has(s.name),
  };
}

function resolveAuthSource(
  apiKeyEnv: string,
  inheritPi: boolean,
  paths: PathResolution
): { source: ConfigSource; detail?: string } {
  if (process.env[apiKeyEnv]) {
    return { source: "env", detail: apiKeyEnv };
  }
  const authFile = resolveAuthFile(inheritPi, paths);
  if (!authFile) {
    return { source: "none", detail: "no API key configured" };
  }
  if (authFile === paths.helixSecretsFile) {
    return { source: "helix_home", detail: authFile };
  }
  return { source: "pi", detail: authFile };
}
