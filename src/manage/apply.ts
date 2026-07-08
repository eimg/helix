import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ManageDraft } from "./types.js";
import { resolveDraftPath, validateDraftsForApply } from "./validate.js";

export function applyDrafts(
  helixDir: string,
  drafts: ManageDraft[],
  force: boolean,
): { ok: true; written: string[] } | { ok: false; errors: string[] } {
  if (drafts.length === 0) {
    return { ok: false, errors: ["No drafts to apply"] };
  }

  const validation = validateDraftsForApply(drafts, helixDir, force);
  if (!validation.ok) return validation;

  const written: string[] = [];
  for (const draft of drafts) {
    const abs = resolveDraftPath(helixDir, draft.relativePath)!;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, draft.content.endsWith("\n") ? draft.content : `${draft.content}\n`, "utf-8");
    written.push(draft.relativePath);
  }

  return { ok: true, written };
}
