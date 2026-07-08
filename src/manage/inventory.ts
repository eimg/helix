/**
 * Read-only inventory of repo-local agents and skills under `.helix/`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ManageInventory, ManageInventoryAgent, ManageInventorySkill } from "./types.js";

export function loadManageInventory(helixDir: string): ManageInventory {
  return {
    agents: listAgents(helixDir),
    skills: listSkills(helixDir),
  };
}

function listAgents(helixDir: string): ManageInventoryAgent[] {
  const agentsDir = resolve(helixDir, "agents");
  const out: ManageInventoryAgent[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const relativePath = join("agents", entry);
    const filePath = resolve(helixDir, relativePath);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;
    out.push({
      name: frontmatter.name,
      description: frontmatter.description ?? "",
      relativePath,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listSkills(helixDir: string): ManageInventorySkill[] {
  const skillsDir = resolve(helixDir, "skills");
  const out: ManageInventorySkill[] = [];
  if (!existsSync(skillsDir)) return out;

  let entries: string[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }

  for (const name of entries) {
    const relativePath = join("skills", name, "SKILL.md");
    if (!existsSync(resolve(helixDir, relativePath))) continue;
    out.push({ name, relativePath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatInventoryForPrompt(inventory: ManageInventory): string {
  const agentLines =
    inventory.agents.length === 0
      ? "(none)"
      : inventory.agents.map((a) => `- ${a.name}: ${a.description || "(no description)"} [${a.relativePath}]`).join("\n");
  const skillLines =
    inventory.skills.length === 0
      ? "(none)"
      : inventory.skills.map((s) => `- ${s.name} [${s.relativePath}]`).join("\n");
  return `## Current agents\n${agentLines}\n\n## Current skills\n${skillLines}`;
}
