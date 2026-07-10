/**
 * Loads + validates `.helix/config.json`.
 *
 * v1 schema is intentionally small. We extend it as features land.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RepoContextOptions } from "./context/bootstrap.js";
import {
  applyEnvModelToConfig,
  loadProjectEnv,
  repoRootFromHelixDir,
} from "./config/env.js";

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
  /**
   * When true, Helix falls back to the operator's global pi config
   * (`~/.pi/agent/`) for secrets, model definitions, skills, extensions, and
   * settings — as a read-only last resort. When false (default), Helix is
   * fully self-contained: env var / `~/.helix/` only, never touches `~/.pi/`.
   */
  inheritPi?: boolean;
  /**
   * Repo-local extensions (arbitrary in-process code). OFF by default for
   * safety/portability. Plumbing only for now — enabling later is a config
   * flip, no refactor.
   */
  extensions?: {
    enabled?: boolean; // default false
    paths?: string[]; // additional dirs beyond .helix/extensions/
  };
  /**
   * Phase A: deterministic repo bootstrap injected into orchestrator + first
   * specialist wave. Enabled by default.
   */
  repoContext?: RepoContextOptions;
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
  /**
   * Post-run deliverable side effects. GitHub PR create/merge via `gh` is
   * **off by default** so local-issues / inline demos do not require GitHub.
   * Set `deliverable.pr: true` (and usually `triggers.github.repo`) to enable.
   */
  deliverable?: {
    /** Create/merge a GitHub PR after a successful run. Default false. */
    pr?: boolean;
  };
}

const DEFAULTS: Partial<HelixConfig> = {
  orchestrator: { model: "", workflow: ["planner", "dev", "verifier"], maxIterations: 6 },
  inheritPi: false,
  extensions: { enabled: false },
  repoContext: { enabled: true },
  deliverable: { pr: false },
};

export function loadConfig(helixDir = resolve(process.cwd(), ".helix")): HelixConfig {
  loadProjectEnv(repoRootFromHelixDir(helixDir));

  const raw = readFileSync(resolve(helixDir, "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<HelixConfig>;
  let config: HelixConfig = {
    provider: parsed.provider ?? { name: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    orchestrator: {
      model: parsed.orchestrator?.model ?? DEFAULTS.orchestrator!.model!,
      workflow: parsed.orchestrator?.workflow ?? DEFAULTS.orchestrator!.workflow!,
      maxIterations: parsed.orchestrator?.maxIterations ?? DEFAULTS.orchestrator!.maxIterations,
      loops: parsed.orchestrator?.loops,
    },
    inheritPi: parsed.inheritPi ?? DEFAULTS.inheritPi,
    extensions: {
      enabled: parsed.extensions?.enabled ?? DEFAULTS.extensions!.enabled!,
      paths: parsed.extensions?.paths,
    },
    repoContext: {
      ...DEFAULTS.repoContext,
      ...parsed.repoContext,
    },
    deliverable: {
      ...DEFAULTS.deliverable,
      ...parsed.deliverable,
    },
    triggers: parsed.triggers,
    mergeGate: parsed.mergeGate,
  };

  config = applyEnvModelToConfig(config);

  if (!config.provider.name) throw new Error("config: provider.name is required");
  if (!config.orchestrator.model) {
    throw new Error(
      "config: orchestrator.model is required (set in .helix/config.json or HELIX_MODEL in .env)"
    );
  }
  if (config.orchestrator.workflow.length === 0) throw new Error("config: orchestrator.workflow must list at least one specialist");

  return config;
}

/** Convenience: true if repo-local extensions are enabled. */
export function extensionsEnabled(config: HelixConfig): boolean {
  return config.extensions?.enabled === true;
}

/** True when post-run GitHub PR create/merge via `gh` is enabled. */
export function githubPrEnabled(config: HelixConfig): boolean {
  return config.deliverable?.pr === true;
}
