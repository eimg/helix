/**
 * Pickup + validation for Prelude's prelude.bootstrap.v1 export.
 * Helix treats bootstrap.json as the authoritative handoff file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PRELUDE_BOOTSTRAP_SCHEMA = "prelude.bootstrap.v1" as const;

export interface BootstrapDocument {
  path: string;
  title: string;
  kind: string;
  body: string;
}

export interface BootstrapArtifactRef {
  id: number;
  filename: string;
  mediaType: string;
  byteSize: number;
  note: string;
  relativePath: string;
}

export interface BootstrapPrimerNote {
  id: number;
  question: string;
  answer: string;
  projectId: string;
  evidence: unknown;
  createdAt: number;
}

export interface BootstrapManifest {
  schemaVersion: typeof PRELUDE_BOOTSTRAP_SCHEMA;
  inceptionId: number;
  name: string;
  version: number;
  acceptedAt: number;
  exportedAt: number;
  exportPath: string;
  brief: string;
  documents: BootstrapDocument[];
  artifacts: BootstrapArtifactRef[];
  primerNotes: BootstrapPrimerNote[];
  files: {
    indexMarkdown: string;
    documentsDir: string;
    artifactsDir: string;
    primerDir: string;
  };
}

export interface BootstrapPickup {
  exportDir: string;
  manifestPath: string;
  manifest: BootstrapManifest;
  indexExists: boolean;
  documentsOnDisk: number;
  artifactsOnDisk: number;
  primerNotesOnDisk: number;
}

export function loadBootstrapManifest(exportDir: string): BootstrapPickup {
  const resolved = resolve(exportDir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Bootstrap export directory not found: ${resolved}`);
  }

  const manifestPath = join(resolved, "bootstrap.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing bootstrap.json in ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Invalid bootstrap.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const manifest = validateManifest(parsed);
  const documentsDir = join(resolved, manifest.files.documentsDir || "documents");
  const artifactsDir = join(resolved, manifest.files.artifactsDir || "artifacts");
  const primerDir = join(resolved, manifest.files.primerDir || "primer");

  return {
    exportDir: resolved,
    manifestPath,
    manifest,
    indexExists: existsSync(join(resolved, manifest.files.indexMarkdown || "INDEX.md")),
    documentsOnDisk: countFiles(documentsDir),
    artifactsOnDisk: countFiles(artifactsDir),
    primerNotesOnDisk: countFiles(primerDir),
  };
}

export function validateManifest(raw: unknown): BootstrapManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("bootstrap.json must be a JSON object");
  }
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== PRELUDE_BOOTSTRAP_SCHEMA) {
    throw new Error(
      `Unsupported schemaVersion ${JSON.stringify(m.schemaVersion)} (expected "${PRELUDE_BOOTSTRAP_SCHEMA}")`,
    );
  }
  if (typeof m.inceptionId !== "number" || !Number.isInteger(m.inceptionId)) {
    throw new Error("bootstrap.json missing integer inceptionId");
  }
  if (typeof m.name !== "string") throw new Error("bootstrap.json missing name");
  if (typeof m.version !== "number" || !Number.isInteger(m.version)) {
    throw new Error("bootstrap.json missing integer version");
  }
  if (typeof m.brief !== "string") throw new Error("bootstrap.json missing brief");
  if (typeof m.exportPath !== "string") throw new Error("bootstrap.json missing exportPath");
  if (!Array.isArray(m.documents)) throw new Error("bootstrap.json missing documents array");
  if (!Array.isArray(m.artifacts)) throw new Error("bootstrap.json missing artifacts array");
  if (!Array.isArray(m.primerNotes)) throw new Error("bootstrap.json missing primerNotes array");
  if (!m.files || typeof m.files !== "object") {
    throw new Error("bootstrap.json missing files object");
  }

  return m as unknown as BootstrapManifest;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else count++;
    }
  };
  walk(dir);
  return count;
}
