/**
 * Parse manage agent JSON output (defensive — first {...} block).
 */
import type { ManageAuthorTurn, ManageDraft, ManageDeletion } from "./types.js";

export function parseManageResponse(text: string): ManageAuthorTurn | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message !== "string" || !obj.message.trim()) return undefined;

  const drafts: ManageDraft[] = [];
  if (Array.isArray(obj.drafts)) {
    for (const item of obj.drafts) {
      const draft = normalizeDraft(item);
      if (draft) drafts.push(draft);
    }
  }

  const deletions: ManageDeletion[] = [];
  if (Array.isArray(obj.deletions)) {
    for (const item of obj.deletions) {
      const deletion = normalizeDeletion(item);
      if (deletion) deletions.push(deletion);
    }
  }

  return { message: obj.message.trim(), drafts, deletions };
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function normalizeDraft(item: unknown): ManageDraft | undefined {
  if (!item || typeof item !== "object") return undefined;
  const d = item as Record<string, unknown>;
  const kind = d.kind;
  if (
    kind !== "agent" &&
    kind !== "pr-agent" &&
    kind !== "inception-agent" &&
    kind !== "skill" &&
    kind !== "inception-skill"
  ) {
    return undefined;
  }
  if (typeof d.relativePath !== "string" || !d.relativePath.trim()) return undefined;
  if (typeof d.content !== "string") return undefined;
  return {
    kind,
    relativePath: d.relativePath.trim().replace(/\\/g, "/"),
    content: d.content,
  };
}

function normalizeDeletion(item: unknown): ManageDeletion | undefined {
  if (!item || typeof item !== "object") return undefined;
  const d = item as Record<string, unknown>;
  const kind = d.kind;
  if (
    kind !== "agent" &&
    kind !== "pr-agent" &&
    kind !== "inception-agent" &&
    kind !== "skill" &&
    kind !== "inception-skill"
  ) {
    return undefined;
  }
  if (typeof d.relativePath !== "string" || !d.relativePath.trim()) return undefined;
  return {
    kind,
    relativePath: d.relativePath.trim().replace(/\\/g, "/"),
  };
}
