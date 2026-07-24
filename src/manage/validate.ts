/**
 * Validate manage drafts before writing to disk.
 */
import { existsSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ManageDraft, ManageDeletion } from "./types.js";

const AGENT_PATH = /^agents\/[a-z0-9-]+\.md$/;
const PR_AGENT_PATH = /^pr-agents\/(reviewer|verifier)\.md$/;
const SKILL_PATH = /^skills\/[a-z0-9-]+\/SKILL\.md$/;

export { AGENT_PATH, PR_AGENT_PATH, SKILL_PATH };

export function validateDraft(draft: ManageDraft, _helixDir: string): string | undefined {
  if (draft.kind === "agent" || draft.kind === "pr-agent") {
    const pathPattern = draft.kind === "pr-agent" ? PR_AGENT_PATH : AGENT_PATH;
    const expectedPath = draft.kind === "pr-agent" ? "pr-agents/(reviewer|verifier).md" : "agents/<name>.md";
    if (!pathPattern.test(draft.relativePath)) {
      return `Invalid ${draft.kind} path "${draft.relativePath}" (expected ${expectedPath})`;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(draft.content);
    if (!frontmatter.name?.trim()) return `Agent ${draft.relativePath} missing frontmatter "name"`;
    if (!frontmatter.description?.trim()) return `Agent ${draft.relativePath} missing frontmatter "description"`;
    if (!body.trim()) return `Agent ${draft.relativePath} has empty body (system prompt)`;
    if (draft.kind === "pr-agent") {
      const role = draft.relativePath.match(PR_AGENT_PATH)?.[1];
      if (frontmatter.name.trim() !== role) {
        return `PR agent ${draft.relativePath} must use frontmatter name "${role}"`;
      }
    }
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

export function validateDeletion(deletion: ManageDeletion): string | undefined {
  if (deletion.kind === "agent" && !AGENT_PATH.test(deletion.relativePath)) {
    return `Invalid agent delete path "${deletion.relativePath}"`;
  }
  if (deletion.kind === "pr-agent" && !PR_AGENT_PATH.test(deletion.relativePath)) {
    return `Invalid pr-agent delete path "${deletion.relativePath}"`;
  }
  if (deletion.kind === "skill" && !SKILL_PATH.test(deletion.relativePath)) {
    return `Invalid skill delete path "${deletion.relativePath}"`;
  }
  return undefined;
}

export function validateDeletionsForApply(
  deletions: ManageDeletion[],
  helixDir: string,
  workflowAgents: string[],
  draftPaths: Set<string>,
  force: boolean,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const deletion of deletions) {
    const pathErr = validateDeletion(deletion);
    if (pathErr) errors.push(pathErr);

    if (seen.has(deletion.relativePath)) {
      errors.push(`Duplicate deletion path: ${deletion.relativePath}`);
    }
    seen.add(deletion.relativePath);

    if (draftPaths.has(deletion.relativePath)) {
      errors.push(`Cannot delete and write the same path: ${deletion.relativePath}`);
    }

    if (!resolveDraftPath(helixDir, deletion.relativePath)) {
      errors.push(`Path escapes .helix/: ${deletion.relativePath}`);
      continue;
    }

    if (!draftExists(helixDir, deletion.relativePath)) {
      errors.push(`File does not exist: ${deletion.relativePath}`);
    }

    if (deletion.kind === "agent" && !force) {
      const agentName = agentNameFromPath(deletion.relativePath);
      if (agentName && workflowAgents.includes(agentName)) {
        errors.push(
          `Agent "${agentName}" is in orchestrator.workflow — enable overwrite or remove from workflow first`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function agentNameFromPath(relativePath: string): string | undefined {
  const m = relativePath.match(/^agents\/([a-z0-9-]+)\.md$/);
  return m?.[1];
}
