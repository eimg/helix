/**
 * Specialist definition loader.
 *
 * Mirrors pi's subagent example: `.helix/agents/*.md` with frontmatter
 * { name, description, model?, tools? } and a system-prompt body.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SpecialistDefinition } from "../engine/types.js";

export function loadSpecialists(agentsDir: string): SpecialistDefinition[] {
  const defs: SpecialistDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return defs;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(agentsDir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    defs.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      systemPrompt: body.trim(),
      filePath,
      source: "project",
    });
  }
  return defs;
}

export function findHelixDir(cwd = process.cwd()): string {
  return resolve(cwd, ".helix");
}
