/**
 * `helix bootstrap` — empty-workspace entry from a local export dir, package URL,
 * or export catalog (soft HTTP contract).
 *
 * Execute creates a new git repository in place, copies the bootstrap export,
 * runs `helix init`, then runs inception agents (architect → scaffolder →
 * validator) with auto-loaded inception skills.
 */
import { resolve } from "node:path";
import type { PiProvider } from "../providers/openrouter.js";
import { OpenRouterProvider } from "../providers/openrouter.js";
import {
  runBootstrap,
  type BootstrapAcceptedResult,
  type BootstrapExecuteResult,
  type BootstrapPreview,
} from "./service.js";
import type { CreateBootstrapSpecialistFactory } from "./runner.js";

export interface BootstrapCommandOptions {
  exportPath?: string;
  exportUrl?: string;
  exportCatalogUrl?: string;
  exportId?: number;
  /** New project directory. Defaults to `process.cwd()`. */
  targetDir: string;
  dryRun: boolean;
  /** Resume inception agents on an already-materialized workspace. */
  runAgents: boolean;
  force: boolean;
  preset?: string;
  helixDir?: string;
  cwd?: string;
  provider?: PiProvider;
  createSpecialistFactory?: CreateBootstrapSpecialistFactory;
}

export function parseBootstrapArgs(args: string[], cwd = process.cwd()): BootstrapCommandOptions {
  let exportPath: string | undefined;
  let exportUrl: string | undefined;
  let exportCatalogUrl: string | undefined;
  let exportId: number | undefined;
  let targetDir: string | undefined;
  let dryRun = true;
  let runAgents = false;
  let force = false;
  let preset: string | undefined;
  let sawExecute = false;
  let sawDryRun = false;
  let sawRunAgents = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--export") exportPath = args[++i];
    else if (a === "--export-url") exportUrl = args[++i];
    else if (a === "--export-catalog") exportCatalogUrl = args[++i];
    else if (a === "--export-id") {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--export-id requires a positive integer");
      }
      exportId = n;
    } else if (a === "--target") targetDir = args[++i];
    else if (a === "--dry-run") {
      dryRun = true;
      sawDryRun = true;
    } else if (a === "--execute") {
      dryRun = false;
      sawExecute = true;
    } else if (a === "--run-agents") {
      dryRun = false;
      runAgents = true;
      sawRunAgents = true;
    } else if (a === "--force") force = true;
    else if (a === "--preset") preset = args[++i];
    else {
      throw new Error(`Unknown bootstrap option: ${a}`);
    }
  }

  const modeCount = [sawDryRun, sawExecute, sawRunAgents].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error("Use only one of --dry-run, --execute, or --run-agents");
  }

  const sources = [
    Boolean(exportPath?.trim()),
    Boolean(exportUrl?.trim()),
    Boolean(exportCatalogUrl?.trim() && exportId !== undefined),
  ].filter(Boolean).length;

  if (!runAgents) {
    if (sources === 0) {
      throw new Error(
        "helix bootstrap requires --export <dir>, --export-url <url>, or --export-catalog <base> --export-id <n>",
      );
    }
    if (sources > 1) {
      throw new Error("Provide only one of --export, --export-url, or --export-catalog/--export-id");
    }
    if (exportCatalogUrl?.trim() && exportId === undefined) {
      throw new Error("--export-catalog requires --export-id");
    }
    if (exportId !== undefined && !exportCatalogUrl?.trim()) {
      throw new Error("--export-id requires --export-catalog");
    }
  }
  if (targetDir !== undefined && !targetDir.trim()) {
    throw new Error("--target requires a directory path");
  }

  return {
    exportPath: exportPath?.trim(),
    exportUrl: exportUrl?.trim(),
    exportCatalogUrl: exportCatalogUrl?.trim(),
    exportId,
    targetDir: resolve(cwd, targetDir?.trim() || cwd),
    dryRun,
    runAgents,
    force,
    preset,
    cwd,
  };
}

export async function runBootstrapCommand(opts: BootstrapCommandOptions): Promise<void> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const provider = opts.provider ?? new OpenRouterProvider();
  const result = await runBootstrap({
    exportPath: opts.exportPath,
    exportUrl: opts.exportUrl,
    exportCatalogUrl: opts.exportCatalogUrl,
    exportId: opts.exportId,
    targetDir: opts.targetDir,
    dryRun: opts.dryRun,
    execute: !opts.dryRun && !opts.runAgents,
    runAgents: opts.runAgents,
    force: opts.force,
    preset: opts.preset,
    helixDir: opts.helixDir,
    cwd,
    provider,
    createSpecialistFactory: opts.createSpecialistFactory,
  });

  printPreview(result.dryRun ? result : result.preview, cwd);

  if (result.dryRun) {
    console.log("Dry run only — no workspace written.");
    console.log(
      "Execute with: helix bootstrap --export … | --export-url … | --export-catalog … --export-id … [--target <dir>] --execute",
    );
    return;
  }

  printExecute(result);
}

function printPreview(preview: BootstrapPreview, cwd: string): void {
  const { pickup, assessment, specialists, skills, roles, targetDir } = preview;
  console.log("Bootstrap export pickup");
  console.log(`  schema:     ${pickup.schemaVersion}`);
  console.log(`  inception:  ${pickup.name} (#${pickup.inceptionId})`);
  console.log(`  version:    v${pickup.version}`);
  console.log(`  export:     ${pickup.exportDir}`);
  console.log(`  brief:      ${summarize(pickup.brief, 120)}`);
  console.log(`  documents:  ${pickup.documents} in manifest · ${pickup.documentsOnDisk} on disk`);
  console.log(`  artifacts:  ${pickup.artifacts} in manifest · ${pickup.artifactsOnDisk} on disk`);
  console.log(`  primer:     ${pickup.primerNotes} notes · ${pickup.primerNotesOnDisk} files`);
  console.log(`  INDEX.md:   ${pickup.indexExists ? "present" : "missing"}`);
  console.log("");
  console.log("Empty-workspace target");
  console.log(`  target:     ${targetDir}${resolve(targetDir) === resolve(cwd) ? " (current folder)" : ""}`);
  console.log(`  git:        ${assessment.hasGit ? "present" : "will create on execute"}`);
  console.log(`  helix:      ${assessment.hasHelixConfig ? "scaffold present" : "will create on execute"}`);
  console.log("");
  console.log("Inception specialists (fixed roles)");
  console.log(`  order: ${roles.join(" → ")}`);
  if (specialists.length === 0) {
    console.log("  (none resolved — check presets/inception-agents)");
  } else {
    for (const item of specialists) {
      console.log(`  - ${item.name}: ${item.description || "(no description)"} [${item.source}]`);
    }
  }
  console.log("");
  console.log("Bootstrap skills (auto-loaded into inception sessions)");
  if (skills.length === 0) {
    console.log("  (none — add under .helix/inception-skills/ via Manage)");
  } else {
    for (const item of skills) {
      console.log(`  - ${item.name} [${item.source}]`);
    }
  }
  console.log("");
}

function printExecute(result: BootstrapExecuteResult | BootstrapAcceptedResult): void {
  const { materialize, job } = result;
  console.log("Materialized project scaffold");
  console.log(`  target:     ${materialize.targetDir}`);
  console.log(`  git:        initialized`);
  console.log(`  documents:  ${materialize.documentsWritten}`);
  console.log(`  artifacts:  ${materialize.artifactsWritten}`);
  console.log(`  primer:     ${materialize.primerNotesWritten}`);
  console.log(`  helix:      initialized (.helix/)`);
  console.log("");
  console.log("Inception agents");
  console.log(`  job:        ${job.id}`);
  console.log(`  status:     ${job.status}`);
  for (const role of job.roles) {
    const detail = role.error ? ` — ${role.error}` : role.status === "done" ? " ✓" : "";
    console.log(`  - ${role.role}: ${role.status}${detail}`);
  }
  if (job.status === "completed") {
    console.log("");
    console.log("Bootstrap complete. Next: helix run --title \"…\" (or keep using helix serve)");
  } else if (job.status === "failed") {
    console.log("");
    console.log(`Bootstrap agents failed: ${job.error ?? "unknown error"}`);
    console.log("Retry with: helix bootstrap --run-agents [--export …]");
  }
}

function summarize(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
