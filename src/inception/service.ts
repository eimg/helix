/**
 * Shared inception/bootstrap service for CLI and HTTP.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HelixConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { findHelixDir } from "../agents/loader.js";
import { resolveInceptionSpecialists } from "./loader.js";
import { loadBootstrapManifest, type BootstrapPickup } from "./manifest.js";
import { materializeBootstrap, type MaterializeResult } from "./materialize.js";
import { DEFAULT_INCEPTION_ROLES, type InceptionRole } from "./roles.js";
import { resolveInceptionSkills, type ResolvedInceptionSkill } from "./skills.js";
import { assessInceptionTarget, assertInceptionTarget, type InceptionTargetAssessment } from "./workspace.js";

export interface WorkspaceStatus {
  cwd: string;
  hasGit: boolean;
  hasHelixConfig: boolean;
  empty: boolean;
  foreignEntries: string[];
  bootstrap: { available: boolean; reason?: string };
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
}

export interface BootstrapRequest {
  exportPath: string;
  targetDir?: string;
  dryRun?: boolean;
  execute?: boolean;
  force?: boolean;
  preset?: string;
  helixDir?: string;
  cwd?: string;
}

export function getWorkspaceStatus(cwd = process.cwd()): WorkspaceStatus {
  const root = resolve(cwd);
  const assessment = assessInceptionTarget(root);
  const helixDir = findHelixDir(root);
  const { roles, specialists, skills } = loadInceptionContext(helixDir);

  const bootstrapAvailable = !assessment.hasGit;
  const prAvailable = assessment.hasGit;

  return {
    cwd: root,
    hasGit: assessment.hasGit,
    hasHelixConfig: assessment.hasHelixConfig,
    empty: assessment.empty,
    foreignEntries: assessment.foreignEntries,
    bootstrap: {
      available: bootstrapAvailable,
      reason: bootstrapAvailable
        ? undefined
        : "Bootstrap is for empty workspaces. This folder already has a Git repository.",
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

export function runBootstrap(opts: BootstrapRequest): BootstrapPreview | BootstrapExecuteResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const targetDir = resolve(opts.targetDir ?? cwd);
  const force = opts.force === true;
  const execute = opts.execute === true || opts.dryRun === false;

  if (execute) {
    assertInceptionTarget(targetDir, { force });
  }

  const assessment = assessInceptionTarget(targetDir);
  if (assessment.hasGit) {
    throw new Error(
      `Target ${assessment.targetDir} already has a Git repository. Bootstrap is only available in empty non-git workspaces.`,
    );
  }
  if (!assessment.empty && !force && execute) {
    throw new Error(
      `Target ${assessment.targetDir} is not an empty workspace (${assessment.foreignEntries.slice(0, 5).join(", ")}). Use force to proceed.`,
    );
  }

  const pickup = loadBootstrapManifest(opts.exportPath);
  const helixDir = opts.helixDir ?? findHelixDir(targetDir);
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

  const materialize = materializeBootstrap({
    pickup,
    targetDir,
    preset: opts.preset,
    force: force || assessment.hasHelixConfig,
  });

  return { dryRun: false, preview, materialize };
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
