/** Manage session types — authoring agents/skills via prompt (separate from issue runs). */

export type ManageSessionStatus = "active" | "applied" | "discarded" | "error";

export type ManageEventType =
  | "session_started"
  | "message_sent"
  | "assistant_replied"
  | "draft_updated"
  | "deletion_updated"
  | "applied"
  | "error";

export interface ManageEvent {
  ts: number;
  type: ManageEventType;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ManageMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ManageDraft {
  kind: "agent" | "pr-agent" | "skill";
  /** Path relative to `.helix/` — e.g. `agents/dev.md`, `pr-agents/verifier.md`, or `skills/foo/SKILL.md`. */
  relativePath: string;
  content: string;
}

/** Explicit delete proposal — applied only after operator confirms Apply. */
export interface ManageDeletion {
  kind: "agent" | "pr-agent" | "skill";
  /** Path relative to `.helix/` — same rules as drafts. */
  relativePath: string;
}

export interface ManageSession {
  id: string;
  status: ManageSessionStatus;
  startedAt: number;
  finishedAt?: number;
  messages: ManageMessage[];
  drafts: ManageDraft[];
  deletions: ManageDeletion[];
  events: ManageEvent[];
  error?: string;
}

export interface ManageInventoryAgent {
  name: string;
  description: string;
  relativePath: string;
}

export interface ManageInventorySkill {
  name: string;
  relativePath: string;
}

export interface ManageInventoryPrAgent extends ManageInventoryAgent {
  source: "project" | "built_in";
  model?: string;
}

export interface ManageInventory {
  agents: ManageInventoryAgent[];
  prAgents: ManageInventoryPrAgent[];
  skills: ManageInventorySkill[];
}

export interface ManageAuthorTurn {
  message: string;
  drafts: ManageDraft[];
  deletions: ManageDeletion[];
}

export interface ManageAuthorOptions {
  cwd?: string;
  helixDir: string;
  modelRef: string;
  extensions?: { enabled?: boolean; paths?: string[] };
}

export interface ManageAuthor {
  complete(userText: string, history: ManageMessage[], inventory: ManageInventory): Promise<ManageAuthorTurn>;
  dispose?(): void;
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
}
