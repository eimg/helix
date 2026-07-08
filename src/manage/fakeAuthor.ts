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
    if (lower.includes("list") || lower.includes("what agents")) {
      const names = inventory.agents.map((a) => a.name).join(", ") || "(none)";
      return { message: `Current agents: ${names}`, drafts: [] };
    }

    if (lower.includes("skill")) {
      return {
        message: "Drafted a sample skill for testing.",
        drafts: [
          {
            kind: "skill",
            relativePath: "skills/sample/SKILL.md",
            content: "# Sample Skill\n\nGate commands for tests.\n",
          },
        ],
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
    };
  }
}
