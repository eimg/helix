/**
 * Shared inception/bootstrap service for CLI and HTTP.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { HelixConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { resolveModelRef } from "../config/env.js";
import { findHelixDir } from "../agents/loader.js";
import type { PiProvider } from "../providers/openrouter.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import { resolveInceptionSpecialists } from "./loader.js";
import { loadBootstrapManifest, type BootstrapPickup } from "./manifest.js";
import { materializeBootstrap, type MaterializeResult } from "./materialize.js";
import {
  agentsFailed,
  agentsSucceeded,
  inceptionJobPath,
  loadInceptionJob,
  saveInceptionJob,
  type InceptionJob,
} from "./job.js";
import {
  runInceptionAgents,
  type CreateBootstrapSpecialistFactory,
} from "./runner.js";
import { DEFAULT_INCEPTION_ROLES, type InceptionRole } from "./roles.js";
import { resolveInceptionSkills, type ResolvedInceptionSkill } from "./skills.js";
import { assessInceptionTarget, assertInceptionTarget, type InceptionTargetAssessment } from "./workspace.js";

export type BootstrapWorkspaceState =
  | "ready"
  | "awaiting_agents"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface WorkspaceStatus {
  cwd: string;
  hasGit: boolean;
  hasHelixConfig: boolean;
  empty: boolean;
  foreignEntries: string[];
  bootstrap: {
    /**
     * Fresh empty-workspace execute is allowed (no git yet).
     * Distinct from `visible`: an existing Helix-bootstrapped repo stays visible
     * but not available for re-execute.
     */
    available: boolean;
    /**
     * Bootstrap page/nav should be shown. True for empty ready workspaces and
     * for existing git repos that still carry inception artifacts.
     */
    visible: boolean;
    /** Helix bootstrap artifacts present (docs/inception, context, or job). */
    hasArtifacts: boolean;
    /** Materialized but inception agents still need to run (or retry). */
    canRunAgents: boolean;
    completed: boolean;
    state: BootstrapWorkspaceState;
    reason?: string;
    job?: InceptionJob;
  };
  prReviews: { available: boolean; reason?: string };
  inception: {
    roles: InceptionRole[];
    specialists: Array<{
      name: string;
      description: string;
      source: "project" | "built_in";
    }>;
    skills: ResolvedInceptionSkill[];
  };
}

export interface BootstrapPreview {
  dryRun: true;
  targetDir: string;
  assessment: InceptionTargetAssessment;
  pickup: {
    exportDir: string;
    schemaVersion: string;
    inceptionId: number;
    name: string;
    version: number;
    brief: string;
    documents: number;
    documentsOnDisk: number;
    artifacts: number;
    artifactsOnDisk: number;
    primerNotes: number;
    primerNotesOnDisk: number;
    indexExists: boolean;
  };
  roles: InceptionRole[];
  specialists: Array<{
    name: string;
    description: string;
    source: "project" | "built_in";
  }>;
  skills: ResolvedInceptionSkill[];
}

export interface BootstrapExecuteResult {
  dryRun: false;
  preview: BootstrapPreview;
  materialize: MaterializeResult;
  job: InceptionJob;
}

export interface BootstrapRequest {
  exportPath?: string;
  targetDir?: string;
  dryRun?: boolean;
  execute?: boolean;
  /** Run agents only against an already-materialized workspace. */
  runAgents?: boolean;
  force?: boolean;
  preset?: string;
  helixDir?: string;
  cwd?: string;
  provider?: PiProvider;
  onJobUpdate?: (job: InceptionJob) => void;
  createSpecialistFactory?: CreateBootstrapSpecialistFactory;
  /**
   * When true, materialize (if needed) and start agents without awaiting them.
   * Used by HTTP; CLI leaves this false and waits for completion.
   */
  detachAgents?: boolean;
}

export interface BootstrapAcceptedResult {
  dryRun: false;
  accepted: true;
  preview: BootstrapPreview;
  materialize: MaterializeResult;
  job: InceptionJob;
}

const activeJobs = new Map<string, Promise<InceptionJob>>();

export function getWorkspaceStatus(cwd = process.cwd()): WorkspaceStatus {
  const root = resolve(cwd);
  const assessment = assessInceptionTarget(root);
  const helixDir = findHelixDir(root);
  const { roles, specialists, skills } = loadInceptionContext(helixDir);
  const job = loadInceptionJob(helixDir);
  const hasArtifacts = hasBootstrapArtifacts(root, helixDir);
  const materialized = isMaterialized(root, assessment.hasGit, assessment.hasHelixConfig);
  const completed = hasArtifacts && agentsSucceeded(job);
  const failed = hasArtifacts && agentsFailed(job);
  const running =
    hasArtifacts && (job?.status === "running_agents" || job?.status === "materializing");

  let bootstrapState: BootstrapWorkspaceState = "ready";
  let bootstrapReason: string | undefined;

  if (completed) {
    bootstrapState = "completed";
    bootstrapReason =
      "Bootstrap finished. Continue with Run, Manage, or PR Reviews.";
  } else if (running) {
    bootstrapState = "running";
    bootstrapReason = job?.currentRole
      ? `Inception agents running (${job.currentRole})…`
      : "Inception bootstrap is running…";
  } else if (failed) {
    bootstrapState = "failed";
    bootstrapReason = job?.error
      ? `Bootstrap agents failed: ${job.error}`
      : "Bootstrap agents failed. Retry from the Bootstrap page.";
  } else if (materialized || (assessment.hasGit && hasArtifacts)) {
    bootstrapState = "awaiting_agents";
    bootstrapReason =
      "Export is materialized (git + Helix), but inception agents have not finished yet. Run architect → scaffolder → validator to build the project foundation.";
  } else if (assessment.hasGit) {
    bootstrapState = "blocked";
    bootstrapReason =
      "This folder is an existing Git repository without Helix bootstrap artifacts. Bootstrap stays available only for empty workspaces, or for projects Helix already bootstrapped (read-only receipt).";
  }

  const available = bootstrapState === "ready";
  const visible = available || hasArtifacts;

  const prAvailable = assessment.hasGit;

  return {
    cwd: root,
    hasGit: assessment.hasGit,
    hasHelixConfig: assessment.hasHelixConfig,
    empty: assessment.empty,
    foreignEntries: assessment.foreignEntries,
    bootstrap: {
      available,
      visible,
      hasArtifacts,
      canRunAgents: bootstrapState === "awaiting_agents" || bootstrapState === "failed",
      completed,
      state: bootstrapState,
      reason: bootstrapReason,
      job,
    },
    prReviews: {
      available: prAvailable,
      reason: prAvailable
        ? undefined
        : "PR Reviews need a Git repository. Run Bootstrap first in this empty workspace.",
    },
    inception: { roles, specialists, skills },
  };
}

/** True when this workspace carries Helix inception/bootstrap evidence. */
export function hasBootstrapArtifacts(root: string, helixDir: string): boolean {
  return (
    existsSync(join(root, "docs", "inception")) ||
    existsSync(join(root, ".helix", "context", "inception.md")) ||
    existsSync(inceptionJobPath(helixDir))
  );
}

export function isMaterialized(root: string, hasGit: boolean, hasHelixConfig: boolean): boolean {
  if (!hasGit || !hasHelixConfig) return false;
  return (
    existsSync(join(root, "docs", "inception")) ||
    existsSync(join(root, ".helix", "context", "inception.md"))
  );
}

/** @deprecated use agentsSucceeded via job — kept for older call sites */
export function isBootstrapCompleted(root: string, hasGit: boolean, hasHelixConfig: boolean): boolean {
  if (!isMaterialized(root, hasGit, hasHelixConfig)) return false;
  return agentsSucceeded(loadInceptionJob(findHelixDir(root)));
}

export async function runBootstrap(
  opts: BootstrapRequest,
): Promise<BootstrapPreview | BootstrapExecuteResult | BootstrapAcceptedResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const targetDir = resolve(opts.targetDir ?? cwd);
  const force = opts.force === true;
  const execute = opts.execute === true || opts.dryRun === false;
  const runAgentsOnly = opts.runAgents === true;
  const helixDir = opts.helixDir ?? findHelixDir(targetDir);
  const provider = opts.provider ?? new OpenRouterProvider();

  if (runAgentsOnly) {
    return startOrAwaitAgents({
      targetDir,
      helixDir,
      provider,
      exportPath: opts.exportPath,
      onJobUpdate: opts.onJobUpdate,
      createSpecialistFactory: opts.createSpecialistFactory,
      detach: opts.detachAgents === true,
    });
  }

  if (execute) {
    assertInceptionTarget(targetDir, { force });
  }

  const assessment = assessInceptionTarget(targetDir);
  if (assessment.hasGit && execute) {
    throw new Error(
      `Target ${assessment.targetDir} already has a Git repository. Bootstrap is only available in empty non-git workspaces (or resume agents if materialize already finished).`,
    );
  }
  if (!assessment.empty && !force && execute) {
    throw new Error(
      `Target ${assessment.targetDir} is not an empty workspace (${assessment.foreignEntries.slice(0, 5).join(", ")}). Use force to proceed.`,
    );
  }

  if (typeof opts.exportPath !== "string" || !opts.exportPath.trim()) {
    throw new Error("exportPath is required");
  }

  const pickup = loadBootstrapManifest(opts.exportPath);
  const { roles, specialists, skills } = loadInceptionContext(helixDir);

  const preview: BootstrapPreview = {
    dryRun: true,
    targetDir,
    assessment,
    pickup: summarizePickup(pickup),
    roles,
    specialists,
    skills,
  };

  if (!execute) return preview;

  if (!provider.hasAuth()) {
    throw new Error(
      "OPENROUTER_API_KEY is required for bootstrap execute (inception agents). Set it in .helix/.env and retry.",
    );
  }

  const materialize = materializeBootstrap({
    pickup,
    targetDir,
    preset: opts.preset,
    force: force || assessment.hasHelixConfig,
  });

  return startOrAwaitAgents({
    targetDir,
    helixDir,
    provider,
    pickup,
    materialize,
    roles,
    preview,
    onJobUpdate: opts.onJobUpdate,
    createSpecialistFactory: opts.createSpecialistFactory,
    detach: opts.detachAgents === true,
  });
}

async function startOrAwaitAgents(opts: {
  targetDir: string;
  helixDir: string;
  provider: PiProvider;
  exportPath?: string;
  pickup?: BootstrapPickup;
  materialize?: MaterializeResult;
  roles?: InceptionRole[];
  preview?: BootstrapPreview;
  onJobUpdate?: (job: InceptionJob) => void;
  createSpecialistFactory?: CreateBootstrapSpecialistFactory;
  detach: boolean;
}): Promise<BootstrapExecuteResult | BootstrapAcceptedResult> {
  const targetDir = resolve(opts.targetDir);
  const helixDir = opts.helixDir;
  const assessment = assessInceptionTarget(targetDir);
  if (!isMaterialized(targetDir, assessment.hasGit, assessment.hasHelixConfig)) {
    throw new Error("Workspace is not materialized yet — run bootstrap execute with an export path first");
  }

  const existing = loadInceptionJob(helixDir);
  const exportPath = opts.exportPath?.trim() || opts.pickup?.exportDir || existing?.exportPath;
  if (!exportPath && !opts.pickup) {
    throw new Error("exportPath is required to run inception agents (no prior bootstrap job found)");
  }

  const pickup = opts.pickup ?? loadBootstrapManifest(exportPath!);
  const { roles, specialists, skills } = loadInceptionContext(helixDir);
  const roleList = opts.roles ?? roles;
  const preview =
    opts.preview ??
    ({
      dryRun: true,
      targetDir,
      assessment,
      pickup: summarizePickup(pickup),
      roles,
      specialists,
      skills,
    } satisfies BootstrapPreview);

  if (!opts.provider.hasAuth()) {
    throw new Error(
      "OPENROUTER_API_KEY is required to run bootstrap agents. Set it in .helix/.env and retry.",
    );
  }

  const key = helixDir;
  const already = activeJobs.get(key);
  if (already) {
    const running = loadInceptionJob(helixDir);
    if (running && (running.status === "running_agents" || running.status === "materializing")) {
      if (opts.detach) {
        return {
          dryRun: false,
          accepted: true,
          preview,
          materialize: running.materialize ?? opts.materialize ?? fallbackMaterialize(targetDir),
          job: running,
        };
      }
      const finished = await already;
      return {
        dryRun: false,
        preview,
        materialize: finished.materialize ?? opts.materialize ?? fallbackMaterialize(targetDir),
        job: finished,
      };
    }
  }

  const materialize = opts.materialize ?? existing?.materialize ?? fallbackMaterialize(targetDir);
  const job: InceptionJob = {
    id: randomUUID(),
    status: "running_agents",
    exportPath: pickup.exportDir,
    targetDir,
    startedAt: Date.now(),
    roles: roleList.map((role) => ({ role, status: "pending" })),
    materialize,
  };
  saveInceptionJob(helixDir, job);
  opts.onJobUpdate?.(job);

  const promise = runInceptionAgents({
    targetDir,
    helixDir,
    pickup,
    provider: opts.provider,
    roles: roleList,
    defaultModel: resolveModelRef().value,
    job,
    onUpdate: opts.onJobUpdate,
    createSpecialistFactory: opts.createSpecialistFactory,
  }).catch((error) => {
    const failed = loadInceptionJob(helixDir) ?? job;
    if (failed.status !== "failed") {
      failed.status = "failed";
      failed.finishedAt = Date.now();
      failed.error = error instanceof Error ? error.message : String(error);
      saveInceptionJob(helixDir, failed);
    }
    return failed;
  });

  activeJobs.set(key, promise);
  void promise.finally(() => {
    if (activeJobs.get(key) === promise) activeJobs.delete(key);
  });

  if (opts.detach) {
    return {
      dryRun: false,
      accepted: true,
      preview,
      materialize,
      job,
    };
  }

  const finished = await promise;
  return {
    dryRun: false,
    preview,
    materialize: finished.materialize ?? materialize,
    job: finished,
  };
}

function fallbackMaterialize(targetDir: string): MaterializeResult {
  return {
    targetDir,
    gitInitialized: true,
    documentsWritten: 0,
    artifactsWritten: 0,
    primerNotesWritten: 0,
    helixInitialized: true,
  };
}

function loadInceptionContext(helixDir: string): {
  roles: InceptionRole[];
  specialists: WorkspaceStatus["inception"]["specialists"];
  skills: ResolvedInceptionSkill[];
} {
  let config: HelixConfig | undefined;
  try {
    if (existsSync(resolve(helixDir, "config.json"))) {
      config = loadConfig(helixDir);
    }
  } catch {
    config = undefined;
  }
  const roles = config?.inception?.roles ?? DEFAULT_INCEPTION_ROLES;
  const specialists = resolveInceptionSpecialists(helixDir, roles).map((item) => ({
    name: item.role,
    description: item.definition.description,
    source: item.source,
  }));
  const skills = resolveInceptionSkills(helixDir);
  return { roles, specialists, skills };
}

function summarizePickup(pickup: BootstrapPickup): BootstrapPreview["pickup"] {
  const { manifest } = pickup;
  return {
    exportDir: pickup.exportDir,
    schemaVersion: manifest.schemaVersion,
    inceptionId: manifest.inceptionId,
    name: manifest.name,
    version: manifest.version,
    brief: manifest.brief,
    documents: manifest.documents.length,
    documentsOnDisk: pickup.documentsOnDisk,
    artifacts: manifest.artifacts.length,
    artifactsOnDisk: pickup.artifactsOnDisk,
    primerNotes: manifest.primerNotes.length,
    primerNotesOnDisk: pickup.primerNotesOnDisk,
    indexExists: pickup.indexExists,
  };
}
