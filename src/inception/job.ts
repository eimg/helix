/**
 * Durable-ish bootstrap job state under `.helix/inception/job.json`.
 * Marks whether inception agents have finished — materialize alone is not "completed".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { InceptionRole } from "./roles.js";
import type { MaterializeResult } from "./materialize.js";

export type InceptionJobStatus =
  | "pending"
  | "materializing"
  | "running_agents"
  | "completed"
  | "failed";

export type InceptionRoleRunStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface InceptionRoleRun {
  role: InceptionRole;
  status: InceptionRoleRunStatus;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
}

export interface InceptionJob {
  id: string;
  status: InceptionJobStatus;
  exportPath: string;
  targetDir: string;
  startedAt: number;
  finishedAt?: number;
  currentRole?: InceptionRole;
  roles: InceptionRoleRun[];
  error?: string;
  materialize?: MaterializeResult;
}

export function inceptionJobPath(helixDir: string): string {
  return resolve(helixDir, "inception", "job.json");
}

export function loadInceptionJob(helixDir: string): InceptionJob | undefined {
  const path = inceptionJobPath(helixDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as InceptionJob;
  } catch {
    return undefined;
  }
}

export function saveInceptionJob(helixDir: string, job: InceptionJob): void {
  const path = inceptionJobPath(helixDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
}

export function agentsSucceeded(job: InceptionJob | undefined): boolean {
  return job?.status === "completed" && job.roles.every((role) => role.status === "done" || role.status === "skipped");
}

export function agentsFailed(job: InceptionJob | undefined): boolean {
  return job?.status === "failed";
}

export function agentsPending(job: InceptionJob | undefined): boolean {
  if (!job) return true;
  return job.status !== "completed" && job.status !== "failed";
}
