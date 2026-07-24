/**
 * Deterministic inception materialize: Prelude export → new project directory.
 *
 * Creates a brand-new git repository at the target, copies inception docs /
 * artifacts / Primer notes, then runs `helix init` for Helix wiring.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { init } from "../init.js";
import { gitInit } from "./git.js";
import type { BootstrapPickup } from "./manifest.js";
import { assertInceptionTarget } from "./workspace.js";

export interface MaterializeOptions {
  pickup: BootstrapPickup;
  targetDir: string;
  /** Stack skill for helix init (default typescript). */
  preset?: string;
  /** Overwrite an existing `.helix/config.json` in the target. */
  force?: boolean;
}

export interface MaterializeResult {
  targetDir: string;
  gitInitialized: boolean;
  documentsWritten: number;
  artifactsWritten: number;
  primerNotesWritten: number;
  helixInitialized: boolean;
}

export function materializeBootstrap(opts: MaterializeOptions): MaterializeResult {
  const targetDir = resolve(opts.targetDir);
  assertInceptionTarget(targetDir, { force: opts.force === true });

  gitInit(targetDir);

  const { manifest, exportDir } = opts.pickup;
  const docsRoot = join(targetDir, "docs", "inception");
  mkdirSync(docsRoot, { recursive: true });

  writeFileSync(join(docsRoot, "BRIEF.md"), ensureTrailingNewline(manifest.brief || "(empty brief)"), "utf-8");

  const indexSrc = join(exportDir, manifest.files.indexMarkdown || "INDEX.md");
  if (existsSync(indexSrc)) {
    cpSync(indexSrc, join(docsRoot, "INDEX.md"));
  }

  const documentsDir = join(exportDir, manifest.files.documentsDir || "documents");
  let documentsWritten = 0;
  for (const document of manifest.documents) {
    const fromDisk = join(documentsDir, document.path);
    const body =
      document.body ||
      (existsSync(fromDisk) ? readFileSync(fromDisk, "utf-8") : "");
    const dest = join(docsRoot, "documents", document.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, ensureTrailingNewline(body), "utf-8");
    documentsWritten++;
  }

  let artifactsWritten = 0;
  const artifactsSrc = join(exportDir, manifest.files.artifactsDir || "artifacts");
  const artifactsDest = join(docsRoot, "artifacts");
  if (existsSync(artifactsSrc)) {
    mkdirSync(artifactsDest, { recursive: true });
    for (const artifact of manifest.artifacts) {
      const name = artifact.filename || artifact.relativePath.split("/").pop();
      if (!name) continue;
      const from = join(artifactsSrc, name);
      if (!existsSync(from)) continue;
      cpSync(from, join(artifactsDest, name));
      artifactsWritten++;
    }
  }

  let primerNotesWritten = 0;
  const primerDest = join(docsRoot, "primer");
  if (manifest.primerNotes.length > 0) {
    mkdirSync(primerDest, { recursive: true });
    for (const note of manifest.primerNotes) {
      const file = join(primerDest, `note-${note.id}.json`);
      writeFileSync(file, `${JSON.stringify(note, null, 2)}\n`, "utf-8");
      primerNotesWritten++;
    }
  } else {
    const primerSrc = join(exportDir, manifest.files.primerDir || "primer");
    if (existsSync(primerSrc)) {
      mkdirSync(primerDest, { recursive: true });
      cpSync(primerSrc, primerDest, { recursive: true });
      primerNotesWritten = countFiles(primerDest);
    }
  }

  writeFileSync(
    join(docsRoot, "SOURCE.json"),
    `${JSON.stringify(
      {
        schemaVersion: manifest.schemaVersion,
        inceptionId: manifest.inceptionId,
        name: manifest.name,
        version: manifest.version,
        exportPath: manifest.exportPath,
        exportedAt: manifest.exportedAt,
        acceptedAt: manifest.acceptedAt,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  if (!existsSync(join(targetDir, "README.md"))) {
    writeFileSync(
      join(targetDir, "README.md"),
      ensureTrailingNewline(
        `# ${manifest.name || "New project"}\n\n${manifest.brief.trim() || "Bootstrapped from a Prelude inception export."}\n`,
      ),
      "utf-8",
    );
  }

  init({
    cwd: targetDir,
    preset: opts.preset ?? "typescript",
    force: opts.force === true,
  });

  const contextDir = join(targetDir, ".helix", "context");
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(
    join(contextDir, "inception.md"),
    ensureTrailingNewline(
      [
        "# Inception context",
        "",
        `Bootstrapped from Prelude export \`${manifest.name}\` v${manifest.version}.`,
        "",
        "See `docs/inception/` for the brief, documents, artifacts, and Primer note snapshots.",
      ].join("\n"),
    ),
    "utf-8",
  );

  return {
    targetDir,
    gitInitialized: true,
    documentsWritten,
    artifactsWritten,
    primerNotesWritten,
    helixInitialized: true,
  };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function countFiles(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(next);
    else count++;
  }
  return count;
}
