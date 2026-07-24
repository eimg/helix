/**
 * Deterministic manage author for tests — no network, no pi session.
 */
import type { ManageAuthor, ManageAuthorTurn, ManageInventory, ManageMessage } from "./types.js";

export class FakeManageAuthor implements ManageAuthor {
  readonly turns: Array<{ userText: string; historyLen: number }> = [];

  constructor(private readonly handler?: (userText: string, inventory: ManageInventory) => ManageAuthorTurn) {}

  async complete(
    userText: string,
    history: ManageMessage[],
    inventory: ManageInventory,
  ): Promise<ManageAuthorTurn> {
    this.turns.push({ userText, historyLen: history.length });
    if (this.handler) return this.handler(userText, inventory);

    const lower = userText.toLowerCase();
    if (lower.includes("delete") || lower.includes("remove")) {
      const skill =
        inventory.inceptionSkills.find((s) => lower.includes(s.name)) ??
        inventory.skills.find((s) => lower.includes(s.name)) ??
        inventory.skills.at(-1) ??
        inventory.inceptionSkills.at(-1);
      if (skill) {
        const kind = skill.relativePath.startsWith("inception-skills/") ? "inception-skill" : "skill";
        return {
          message: `Proposed deleting skill "${skill.name}". Review and click Apply to confirm.`,
          drafts: [],
          deletions: [{ kind, relativePath: skill.relativePath }],
        };
      }
    }

    if (lower.includes("list") || lower.includes("what agents")) {
      const workflow = inventory.agents.map((a) => a.name).join(", ") || "(none)";
      const pr = inventory.prAgents.map((a) => a.name).join(", ") || "(none)";
      const bootstrap = inventory.inceptionAgents.map((a) => a.name).join(", ") || "(none)";
      return {
        message: `Workflow agents: ${workflow}. PR agents: ${pr}. Bootstrap agents: ${bootstrap}.`,
        drafts: [],
        deletions: [],
      };
    }

    if (lower.includes("skill")) {
      if (lower.includes("bootstrap") || lower.includes("inception")) {
        return {
          message: "Drafted a bootstrap skill for testing.",
          drafts: [
            {
              kind: "inception-skill",
              relativePath: "inception-skills/sample/SKILL.md",
              content: "# Sample Bootstrap Skill\n\nFoundation notes for tests.\n",
            },
          ],
          deletions: [],
        };
      }
      return {
        message: "Drafted a sample skill for testing.",
        drafts: [
          {
            kind: "skill",
            relativePath: "skills/sample/SKILL.md",
            content: "# Sample Skill\n\nGate commands for tests.\n",
          },
        ],
        deletions: [],
      };
    }

    if (
      lower.includes("bootstrap") ||
      lower.includes("inception") ||
      lower.includes("architect") ||
      lower.includes("scaffolder") ||
      lower.includes("validator")
    ) {
      const role =
        (["architect", "scaffolder", "validator"] as const).find((name) => lower.includes(name)) ?? "architect";
      return {
        message: `Drafted a bootstrap ${role} override.`,
        drafts: [
          {
            kind: "inception-agent",
            relativePath: `inception-agents/${role}.md`,
            content: `---
name: ${role}
description: Bootstrap ${role} created by FakeManageAuthor for tests.
tools: read, grep
---

You are the **${role}** bootstrap specialist for testing.
`,
          },
        ],
        deletions: [],
      };
    }

    return {
      message: "Drafted a sample agent for testing.",
      drafts: [
        {
          kind: "agent",
          relativePath: "agents/sample.md",
          content: `---
name: sample
description: Sample agent created by FakeManageAuthor for tests.
tools: read, grep
---

You are a sample specialist for testing.
`,
        },
      ],
      deletions: [],
    };
  }
}
