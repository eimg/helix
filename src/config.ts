/**
 * Loads + validates `.helix/config.json`.
 *
 * Config is **wiring only**: workflow, merge gate, triggers,
 * deliverable, extensions, repoContext. Essentials (API key, model) come from
 * `.env` or the operator's global pi install — see `config/env.ts` and
 * `providers/openrouter.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RepoContextOptions } from "./context/bootstrap.js";
import { loadProjectEnv, repoRootFromHelixDir } from "./config/env.js";
import { normalizeInceptionRoles, type InceptionRole } from "./inception/roles.js";

export interface HelixConfig {
  orchestrator: {
    workflow: string[]; // specialist names, default order
    maxIterations?: number;
  };
  /**
   * Empty-workspace inception bootstrap. Fixed roles may be reordered only;
   * Manage edits prompts under `.helix/inception-agents/`.
   */
  inception?: {
    roles: InceptionRole[];
  };
  /**
   * Repo-local extensions (arbitrary in-process code). OFF by default for
   * safety/portability.
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
  };
  /**
   * Post-run deliverable side effects. GitHub PR create/merge via `gh` is
   * **off by default**. Set `deliverable.pr: true` to enable.
   */
  deliverable?: {
    /** Create/merge a GitHub PR after a successful run. Default false. */
    pr?: boolean;
    /** Register a Git-backed local PR with the linked local tracker. */
    localPr?: boolean;
    /** Base branch used for local PR identity. */
    baseBranch?: string;
  };
}

const DEFAULTS: Partial<HelixConfig> = {
  orchestrator: { workflow: ["planner", "dev"], maxIterations: 6 },
  inception: { roles: normalizeInceptionRoles(undefined) },
  extensions: { enabled: false },
  repoContext: { enabled: true },
  deliverable: { pr: false, localPr: true, baseBranch: "main" },
};

export function loadConfig(helixDir = resolve(process.cwd(), ".helix")): HelixConfig {
  loadProjectEnv(repoRootFromHelixDir(helixDir));

  const raw = readFileSync(resolve(helixDir, "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as Partial<HelixConfig> & {
    // Legacy fields ignored if present (pre-wiring-only configs).
    provider?: unknown;
    inheritPi?: unknown;
    orchestrator?: Partial<HelixConfig["orchestrator"]> & { model?: string };
  };

  const config: HelixConfig = {
    orchestrator: {
      workflow: parsed.orchestrator?.workflow ?? DEFAULTS.orchestrator!.workflow!,
      maxIterations: parsed.orchestrator?.maxIterations ?? DEFAULTS.orchestrator!.maxIterations,
    },
    inception: {
      roles: normalizeInceptionRoles(
        parsed.inception && typeof parsed.inception === "object"
          ? (parsed.inception as { roles?: unknown }).roles
          : undefined,
      ),
    },
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
    mergeGate: parsed.mergeGate
      ? {
          autoMerge: parsed.mergeGate.autoMerge,
          maxDiffLines: parsed.mergeGate.maxDiffLines,
          maxFiles: parsed.mergeGate.maxFiles,
        }
      : undefined,
  };

  if (config.orchestrator.workflow.length === 0) {
    throw new Error("config: orchestrator.workflow must list at least one specialist");
  }

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

/** True when Acme-linked runs should register a local PR after implementation. */
export function localPrEnabled(config: HelixConfig): boolean {
  return config.deliverable?.localPr === true;
}
