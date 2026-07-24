import { unlinkSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ManageDeletion, ManageDraft } from "./types.js";
import { resolveDraftPath, validateDeletionsForApply, validateDraftsForApply } from "./validate.js";
import { applyDrafts } from "./apply.js";

export function applyDeletions(
  helixDir: string,
  deletions: ManageDeletion[],
): { ok: true; deleted: string[] } | { ok: false; errors: string[] } {
  const deleted: string[] = [];

  for (const deletion of deletions) {
    const abs = resolveDraftPath(helixDir, deletion.relativePath);
    if (!abs) return { ok: false, errors: [`Path escapes .helix/: ${deletion.relativePath}`] };

    if (deletion.kind === "skill" || deletion.kind === "inception-skill") {
      const skillDir = dirname(abs);
      rmSync(skillDir, { recursive: true, force: true });
      deleted.push(deletion.relativePath.replace(/\/SKILL\.md$/, "/"));
    } else {
      unlinkSync(abs);
      deleted.push(deletion.relativePath);
    }
  }

  return { ok: true, deleted };
}

export function applyChanges(
  helixDir: string,
  drafts: ManageDraft[],
  deletions: ManageDeletion[],
  workflowAgents: string[],
  force: boolean,
): { ok: true; written: string[]; deleted: string[] } | { ok: false; errors: string[] } {
  if (drafts.length === 0 && deletions.length === 0) {
    return { ok: false, errors: ["No changes to apply"] };
  }

  const draftPaths = new Set(drafts.map((d) => d.relativePath));
  const delValidation = validateDeletionsForApply(deletions, helixDir, workflowAgents, draftPaths, force);
  if (!delValidation.ok) return delValidation;

  const draftValidation = validateDraftsForApply(drafts, helixDir, force);
  if (!draftValidation.ok) return draftValidation;

  const written: string[] = [];
  if (drafts.length > 0) {
    const writeResult = applyDrafts(helixDir, drafts, force);
    if (!writeResult.ok) return writeResult;
    written.push(...writeResult.written);
  }

  const deleted: string[] = [];
  if (deletions.length > 0) {
    const deleteResult = applyDeletions(helixDir, deletions);
    if (!deleteResult.ok) return deleteResult;
    deleted.push(...deleteResult.deleted);
  }

  return { ok: true, written, deleted };
}