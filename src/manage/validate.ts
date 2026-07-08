/**
 * Validate manage drafts before writing to disk.
 */
import { existsSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ManageDraft } from "./types.js";

const AGENT_PATH = /^agents\/[a-z0-9-]+\.md$/;
const SKILL_PATH = /^skills\/[a-z0-9-]+\/SKILL\.md$/;

export function validateDraft(draft: ManageDraft, _helixDir: string): string | undefined {
  if (draft.kind === "agent") {
    if (!AGENT_PATH.test(draft.relativePath)) {
      return `Invalid agent path "${draft.relativePath}" (expected agents/<name>.md)`;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(draft.content);
    if (!frontmatter.name?.trim()) return `Agent ${draft.relativePath} missing frontmatter "name"`;
    if (!frontmatter.description?.trim()) return `Agent ${draft.relativePath} missing frontmatter "description"`;
    if (!body.trim()) return `Agent ${draft.relativePath} has empty body (system prompt)`;
    return undefined;
  }

  if (draft.kind === "skill") {
    if (!SKILL_PATH.test(draft.relativePath)) {
      return `Invalid skill path "${draft.relativePath}" (expected skills/<name>/SKILL.md)`;
    }
    if (!draft.content.trim()) return `Skill ${draft.relativePath} is empty`;
    return undefined;
  }

  return `Unknown draft kind`;
}

export function resolveDraftPath(helixDir: string, relativePath: string): string | undefined {
  const normalized = normalize(relativePath).replace(/\\/g, "/");
  if (normalized.startsWith("..") || normalized.includes("/../")) return undefined;
  const abs = resolve(helixDir, normalized);
  if (!abs.startsWith(resolve(helixDir))) return undefined;
  return abs;
}

export function draftExists(helixDir: string, relativePath: string): boolean {
  const abs = resolveDraftPath(helixDir, relativePath);
  return abs ? existsSync(abs) : false;
}

export function validateDraftsForApply(
  drafts: ManageDraft[],
  helixDir: string,
  force: boolean,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const pathErr = validateDraft(draft, helixDir);
    if (pathErr) errors.push(pathErr);

    if (seen.has(draft.relativePath)) {
      errors.push(`Duplicate draft path: ${draft.relativePath}`);
    }
    seen.add(draft.relativePath);

    if (!force && draftExists(helixDir, draft.relativePath)) {
      errors.push(`File exists: ${draft.relativePath} (pass force=true to overwrite)`);
    }

    if (!resolveDraftPath(helixDir, draft.relativePath)) {
      errors.push(`Path escapes .helix/: ${draft.relativePath}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
