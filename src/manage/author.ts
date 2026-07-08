/**
 * LLM manage author — single pi session with read-only repo tools.
 */
import type { Message, AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiProvider } from "../providers/openrouter.js";
import { buildSessionLoader } from "../agents/loaderBuilder.js";
import { MANAGE_SYSTEM_PROMPT } from "./prompt.js";
import { formatInventoryForPrompt } from "./inventory.js";
import { parseManageResponse } from "./parseResponse.js";
import type { ManageAuthor, ManageAuthorOptions, ManageAuthorTurn, ManageInventory, ManageMessage } from "./types.js";

export class LlmManageAuthor implements ManageAuthor {
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  private readonly provider: PiProvider;
  private readonly cwd: string;
  private readonly helixDir: string;
  private readonly inheritPi: boolean;
  private readonly extensions: ManageAuthorOptions["extensions"];
  private readonly modelRef: string;

  constructor(provider: PiProvider, opts: ManageAuthorOptions) {
    this.provider = provider;
    this.cwd = opts.cwd ?? process.cwd();
    this.helixDir = opts.helixDir;
    this.inheritPi = opts.inheritPi ?? false;
    this.extensions = opts.extensions;
    this.modelRef = opts.modelRef;
  }

  async complete(
    userText: string,
    history: ManageMessage[],
    inventory: ManageInventory,
  ): Promise<ManageAuthorTurn> {
    const session = await this.ensureSession();
    const priorUserTurns = (session.messages as Message[]).filter((m) => m.role === "user").length;
    const prompt =
      priorUserTurns === 0
        ? buildUserPrompt(userText, history, inventory)
        : userText.trim();

    try {
      await session.prompt(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        message: `Manage assistant call failed: ${message}`,
        drafts: [],
      };
    }

    const messages = session.messages as Message[];
    const assistant = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
    const raw =
      assistant?.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim() ?? "";

    const parsed = parseManageResponse(raw);
    if (parsed) return parsed;

    return {
      message: raw || "Manage assistant returned an empty response.",
      drafts: [],
    };
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = undefined;
  }

  private async ensureSession() {
    if (this.session) return this.session;
    const model = await this.provider.resolveModel(this.modelRef);
    const loader = buildSessionLoader({
      cwd: this.cwd,
      helixDir: this.helixDir,
      inheritPi: this.inheritPi,
      extensions: this.extensions,
      systemPromptOverride: MANAGE_SYSTEM_PROMPT,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      thinkingLevel: "off",
      tools: ["read", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      authStorage: this.provider.authStorage,
      modelRegistry: this.provider.modelRegistry,
    });
    this.session = session;
    return session;
  }
}

function buildUserPrompt(userText: string, history: ManageMessage[], inventory: ManageInventory): string {
  const parts: string[] = [formatInventoryForPrompt(inventory), ""];

  if (history.length > 0) {
    parts.push("## Conversation so far");
    for (const msg of history) {
      parts.push(`${msg.role === "user" ? "Operator" : "Assistant"}: ${msg.content}`);
    }
    parts.push("");
  }

  parts.push("## Operator request");
  parts.push(userText.trim());
  parts.push("");
  parts.push("Reply with ONE JSON object per the schema in your system prompt.");

  return parts.join("\n");
}

export type { ManageInventory };
