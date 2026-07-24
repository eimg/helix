/**
 * Run fixed inception roles (architect → scaffolder → validator) against a
 * materialized empty-workspace bootstrap target.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SpecialistDefinition, SpecialistSessionFactory } from "../engine/types.js";
import { resolveModelRef } from "../config/env.js";
import type { PiProvider } from "../providers/openrouter.js";
import type { PiSpecialistFactoryOptions } from "../agents/session.js";
import { loadInceptionSpecialists } from "./loader.js";
import {
  agentsSucceeded,
  loadInceptionJob,
  saveInceptionJob,
  type InceptionJob,
} from "./job.js";
import { DEFAULT_INCEPTION_ROLES, type InceptionRole } from "./roles.js";
import { createInceptionSpecialistFactory } from "./specialists.js";
import type { BootstrapPickup } from "./manifest.js";
import { commitBootstrapTree } from "./git.js";

export type CreateBootstrapSpecialistFactory = (
  provider: PiProvider,
  definitions: SpecialistDefinition[],
  opts?: Omit<PiSpecialistFactoryOptions, "skillPack">,
) => SpecialistSessionFactory;

export interface RunInceptionAgentsOptions {
  targetDir: string;
  helixDir: string;
  pickup: BootstrapPickup;
  provider: PiProvider;
  roles?: readonly InceptionRole[];
  defaultModel?: string;
  job?: InceptionJob;
  onUpdate?: (job: InceptionJob) => void;
  /** Inject for tests; defaults to inception skill-pack pi sessions. */
  createSpecialistFactory?: CreateBootstrapSpecialistFactory;
}

export async function runInceptionAgents(opts: RunInceptionAgentsOptions): Promise<InceptionJob> {
  if (!opts.provider.hasAuth()) {
    throw new Error(
      "OPENROUTER_API_KEY is required to run bootstrap agents (architect / scaffolder / validator). Set it in .helix/.env and retry.",
    );
  }

  const roles = opts.roles ?? DEFAULT_INCEPTION_ROLES;
  const definitions = loadInceptionSpecialists(opts.helixDir, roles);
  if (definitions.length === 0) {
    throw new Error("No inception specialists resolved — check presets/inception-agents");
  }

  const job: InceptionJob = opts.job ?? loadInceptionJob(opts.helixDir) ?? {
    id: `inception-${Date.now()}`,
    status: "running_agents",
    exportPath: opts.pickup.exportDir,
    targetDir: opts.targetDir,
    startedAt: Date.now(),
    roles: roles.map((role) => ({ role, status: "pending" as const })),
  };

  job.status = "running_agents";
  job.error = undefined;
  ensureRoleSlots(job, roles);
  persist(opts.helixDir, job, opts.onUpdate);

  const defaultModel = opts.defaultModel ?? resolveModelRef().value;
  const createFactory = opts.createSpecialistFactory ?? createInceptionSpecialistFactory;
  const factory = createFactory(opts.provider, definitions, {
    cwd: opts.targetDir,
    helixDir: opts.helixDir,
    defaultModel,
  });

  const planPath = join(opts.targetDir, "docs", "inception", "FOUNDATION_PLAN.md");
  mkdirSync(join(opts.targetDir, "docs", "inception"), { recursive: true });

  try {
    for (const role of roles) {
      const def = definitions.find((item) => item.name === role);
      const slot = job.roles.find((item) => item.role === role);
      if (!def || !slot) continue;

      job.currentRole = role;
      slot.status = "running";
      slot.startedAt = Date.now();
      slot.error = undefined;
      persist(opts.helixDir, job, opts.onUpdate);

      const session = await factory.create(def);
      try {
        const task = buildRoleTask(role, opts.pickup, opts.targetDir, planPath);
        const result = await session.run(task);
        slot.finishedAt = Date.now();
        slot.output = result.output;
        if (!result.ok) {
          slot.status = "failed";
          slot.error = result.error ?? result.output.slice(0, 500);
          job.status = "failed";
          job.error = `${role} failed: ${slot.error}`;
          job.finishedAt = Date.now();
          persist(opts.helixDir, job, opts.onUpdate);
          return job;
        }
        slot.status = "done";
        if (role === "architect") {
          writeFileSync(planPath, `${result.output.trim()}\n`, "utf-8");
        }
        if (role === "validator") {
          writeFileSync(
            join(opts.targetDir, "docs", "inception", "VALIDATION.md"),
            `${result.output.trim()}\n`,
            "utf-8",
          );
        }
        persist(opts.helixDir, job, opts.onUpdate);
      } finally {
        session.dispose();
      }
    }

    job.status = "completed";
    job.currentRole = undefined;
    job.finishedAt = Date.now();
    try {
      commitBootstrapTree(opts.targetDir);
    } catch (error) {
      job.status = "failed";
      job.error = `Bootstrap agents finished, but the foundation commit failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      persist(opts.helixDir, job, opts.onUpdate);
      return job;
    }
    persist(opts.helixDir, job, opts.onUpdate);
    return job;
  } catch (error) {
    job.status = "failed";
    job.finishedAt = Date.now();
    job.error = error instanceof Error ? error.message : String(error);
    if (job.currentRole) {
      const slot = job.roles.find((item) => item.role === job.currentRole);
      if (slot && slot.status === "running") {
        slot.status = "failed";
        slot.error = job.error;
        slot.finishedAt = Date.now();
      }
    }
    persist(opts.helixDir, job, opts.onUpdate);
    throw error;
  }
}

function ensureRoleSlots(job: InceptionJob, roles: readonly InceptionRole[]): void {
  for (const role of roles) {
    if (!job.roles.some((item) => item.role === role)) {
      job.roles.push({ role, status: "pending" });
    }
  }
}

function persist(helixDir: string, job: InceptionJob, onUpdate?: (job: InceptionJob) => void): void {
  saveInceptionJob(helixDir, job);
  onUpdate?.(structuredClone(job));
}

function buildRoleTask(
  role: InceptionRole,
  pickup: BootstrapPickup,
  targetDir: string,
  planPath: string,
): string {
  const { manifest, exportDir } = pickup;
  const common = [
    `Target workspace: ${resolve(targetDir)}`,
    `Prelude export: ${exportDir}`,
    `Inception: ${manifest.name} (#${manifest.inceptionId}) v${manifest.version}`,
    `Schema: ${manifest.schemaVersion}`,
    "",
    "Brief:",
    manifest.brief || "(empty)",
    "",
    "Export documents:",
    ...manifest.documents.map((doc) => `- ${doc.path}${doc.title ? ` (${doc.title})` : ""}`),
    "",
    "Host already copied the export under docs/inception/ and ran helix init when needed.",
    "Prefer reading docs/inception/ and .helix/ rather than inventing requirements.",
  ].join("\n");

  if (role === "architect") {
    return [
      common,
      "",
      "Task: Produce a concrete foundation plan for this empty workspace.",
      "Cover repo layout, baseline tooling, Helix wiring expectations, verified-command checks,",
      "and blocking questions if the export is incomplete.",
      "Do not write project files yet (scaffolder will).",
      "Return the full plan as markdown in your final answer.",
    ].join("\n");
  }

  if (role === "scaffolder") {
    return [
      common,
      "",
      `Foundation plan path: ${planPath} (written by architect — read it).`,
      "Task: Materialize the accepted foundation plan into the target workspace.",
      "Create missing directories/files, refine README/tooling stubs as the plan requires,",
      "and keep changes faithful to the Prelude export.",
      "Git and baseline Helix wiring may already exist — do not re-init git if .git is present.",
      "Summarize what you created or changed.",
    ].join("\n");
  }

  return [
    common,
    "",
    `Foundation plan path: ${planPath}`,
    "Task: Validate the scaffolded workspace against the export and foundation plan.",
    "Check layout, key docs, Helix config, and any verified-command expectations you can run safely.",
    "End with a clear PASS or FAIL decision and concrete evidence.",
    "On FAIL, recommend returning conflict evidence to Prelude — do not redesign.",
  ].join("\n");
}

export { agentsSucceeded };
