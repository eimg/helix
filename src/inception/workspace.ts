/**
 * Empty-workspace rules for inception entry.
 *
 * Happy path: operator `cd`s into an empty folder and runs `helix bootstrap`
 * or `helix serve`. No prior git host is required. Bootstrap execute creates
 * the new project's git repository in place.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { init } from "../init.js";
import { hasOwnGitDir } from "./git.js";

/** Harmless / expected pre-bootstrap files in an otherwise empty workspace. */
export const INCEPTION_ALLOWED_ENTRIES = new Set([
  ".DS_Store",
  ".env",
  ".env.example",
  ".gitignore",
  ".helix",
]);

export interface InceptionTargetAssessment {
  targetDir: string;
  empty: boolean;
  hasGit: boolean;
  hasHelixConfig: boolean;
  foreignEntries: string[];
}

export function assessInceptionTarget(targetDir: string): InceptionTargetAssessment {
  const dir = resolve(targetDir);
  mkdirSync(dir, { recursive: true });
  const entries = readdirSync(dir);
  const foreignEntries = entries.filter((name) => !INCEPTION_ALLOWED_ENTRIES.has(name));
  return {
    targetDir: dir,
    empty: foreignEntries.length === 0,
    hasGit: hasOwnGitDir(dir),
    hasHelixConfig: existsSync(resolve(dir, ".helix", "config.json")),
    foreignEntries,
  };
}

/**
 * Validate a directory for inception entry / materialize.
 * - Must not already own `.git` (bootstrap creates the new project repo).
 * - Must not contain foreign project files unless `force`.
 */
export function assertInceptionTarget(targetDir: string, opts: { force?: boolean } = {}): InceptionTargetAssessment {
  const assessment = assessInceptionTarget(targetDir);

  if (assessment.hasGit) {
    throw new Error(
      `Target ${assessment.targetDir} already has a Git repository. Inception starts in an empty workspace and creates git for the new project.`,
    );
  }

  if (!assessment.empty && !opts.force) {
    throw new Error(
      `Target ${assessment.targetDir} is not an empty workspace (${assessment.foreignEntries.slice(0, 5).join(", ")}${assessment.foreignEntries.length > 5 ? ", …" : ""}). Use an empty folder, or --force to proceed.`,
    );
  }

  return assessment;
}

/**
 * Ensure `.helix/` exists so `helix serve` can start Manage/Config in an empty
 * workspace. Does not create git — that remains bootstrap execute's job.
 */
export function ensureInceptionScaffold(cwd: string, opts: { preset?: string; force?: boolean } = {}): {
  helixDir: string;
  created: boolean;
} {
  const assessment = assertInceptionTarget(cwd, { force: opts.force });
  const helixDir = resolve(assessment.targetDir, ".helix");
  if (assessment.hasHelixConfig && !opts.force) {
    return { helixDir, created: false };
  }
  init({
    cwd: assessment.targetDir,
    preset: opts.preset ?? "typescript",
    force: opts.force === true || assessment.hasHelixConfig,
  });
  return { helixDir, created: true };
}
