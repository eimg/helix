/**
 * Real specialist agent layer: an isolated in-process pi session per
 * specialist, with its own model, system prompt, and tools.
 *
 * This is the production counterpart to `stubSession.ts`. The engine treats
 * both identically via `SpecialistSessionFactory`; tests use the stub, the CLI
 * uses this one.
 *
 * One process, one session per specialist lane and Helix run. The engine keeps
 * lanes alive across invocations, then disposes them when the run finishes.
 */
import type { Api, Model, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type {
  SpecialistDefinition,
  SpecialistActivityLine,
  SpecialistResult,
  SpecialistRunOptions,
  SpecialistSession,
  SpecialistSessionFactory,
} from "../engine/types.js";
import type { PiProvider } from "../providers/openrouter.js";
import { buildSessionLoader, type SkillPack } from "./loaderBuilder.js";

export interface PiSpecialistFactoryOptions {
  /** Working directory specialists operate in. Default process.cwd(). */
  cwd?: string;
  /** `.helix/` dir of the repo. Default <cwd>/.helix. */
  helixDir?: string;
  /**
   * Default model for specialists that omit frontmatter `model:`.
   * From HELIX_MODEL / shipped default — never overrides an explicit agent model.
   */
  defaultModel?: string;
  /**
   * Skill pack loaded into specialist sessions. Default `run` (`.helix/skills`).
   * Bootstrap factories pass `inception` so `.helix/inception-skills/` loads.
   */
  skillPack?: SkillPack;
  /** Repo-local extension config. Default disabled. */
  extensions?: { enabled?: boolean; paths?: string[] };
}

export class PiSpecialistSessionFactory implements SpecialistSessionFactory {
  /** Exposed so the engine can enumerate available specialists. */
  readonly definitions: SpecialistDefinition[];
  private readonly provider: PiProvider;
  private readonly cwd: string;
  private readonly helixDir: string;
  private readonly defaultModel: string | undefined;
  private readonly skillPack: SkillPack;
  private readonly extensions: { enabled?: boolean; paths?: string[] } | undefined;

  constructor(provider: PiProvider, definitions: SpecialistDefinition[], opts: PiSpecialistFactoryOptions = {}) {
    this.provider = provider;
    this.definitions = definitions;
    this.cwd = opts.cwd ?? process.cwd();
    this.helixDir = opts.helixDir ?? resolve(this.cwd, ".helix");
    this.defaultModel = opts.defaultModel;
    this.skillPack = opts.skillPack ?? "run";
    this.extensions = opts.extensions;
  }

  async create(def: SpecialistDefinition): Promise<SpecialistSession> {
    const modelRef = def.model ?? this.defaultModel;
    const model = modelRef ? await this.provider.resolveModel(modelRef) : undefined;
    if (!model) {
      throw new Error(
        `Specialist "${def.name}" has no model (set frontmatter model: or HELIX_MODEL / default)`
      );
    }

    const loader = buildSessionLoader({
      cwd: this.cwd,
      helixDir: this.helixDir,
      skillPack: this.skillPack,
      extensions: this.extensions,
      systemPromptOverride: def.systemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      thinkingLevel: "off",
      tools: def.tools && def.tools.length > 0 ? def.tools : ["read", "bash", "edit", "write"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      authStorage: this.provider.authStorage,
      modelRegistry: this.provider.modelRegistry,
    });

    return new PiSpecialistSession(def.name, session);
  }
}

/**
 * Wraps a pi AgentSession. `run(task)` sends one prompt, waits for idle, and
 * harvests the final assistant text + aggregated usage.
 */
export class PiSpecialistSession implements SpecialistSession {
  constructor(
    readonly name: string,
    private readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  ) {}

  async run(task: string, opts?: SpecialistRunOptions): Promise<SpecialistResult> {
    const onActivity = opts?.onActivity;
    const unsubscribe = onActivity
      ? this.session.subscribe((event) => {
          const line = mapSessionEvent(event);
          if (line) onActivity(line);
        })
      : undefined;

    try {
      await this.session.prompt(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        specialist: this.name,
        task,
        ok: false,
        output: "",
        error: `session prompt failed: ${message}`,
      };
    } finally {
      unsubscribe?.();
    }

    const messages = this.session.messages as Message[];
    const assistant = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");

    if (!assistant) {
      return {
        specialist: this.name,
        task,
        ok: false,
        output: "",
        error: "no assistant response produced",
      };
    }

    const text = assistant.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();

    const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
    const usage = aggregateUsage(messages);

    return {
      specialist: this.name,
      task,
      ok: !failed,
      output: text || (failed ? assistant.errorMessage ?? "(no output)" : "(no output)"),
      usage,
      error: failed ? assistant.errorMessage : undefined,
    };
  }

  dispose(): void {
    try {
      this.session.dispose();
    } catch {
      /* ignore */
    }
  }
}

function aggregateUsage(messages: Message[]): { input: number; output: number; cost: number; turns: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  let turns = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      turns++;
      input += m.usage.input ?? 0;
      output += m.usage.output ?? 0;
      cost += m.usage.cost?.total ?? 0;
    }
  }
  return { input, output, cost, turns };
}

// keep the Model/Api imports referenced for type narrowing
export type { Model, Api };

const MAX_ACTIVITY_LINE = 400;

function mapSessionEvent(event: { type: string; [key: string]: unknown }): SpecialistActivityLine | null {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
      if (update?.type !== "text_delta" || typeof update.delta !== "string" || !update.delta) return null;
      return { kind: "text_delta", line: update.delta };
    }
    case "tool_execution_start": {
      const toolName = String(event.toolName ?? "tool");
      const args = formatToolArgs(event.args);
      return { kind: "tool", toolName, phase: "start", line: `→ ${toolName}${args ? ` ${args}` : ""}` };
    }
    case "tool_execution_end": {
      const toolName = String(event.toolName ?? "tool");
      const isError = event.isError === true;
      const preview = formatToolResult(event.result);
      const status = isError ? "failed" : "done";
      return { kind: "tool", toolName, phase: "end", isError, line: `← ${toolName} ${status}${preview ? `: ${preview}` : ""}` };
    }
    default:
      return null;
  }
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.command === "string") return truncateActivity(record.command);
  if (typeof record.path === "string") return truncateActivity(record.path);
  try {
    return truncateActivity(JSON.stringify(args));
  } catch {
    return "";
  }
}

function formatToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  const text = (record.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text ? truncateActivity(text, 200) : "";
}

function truncateActivity(text: string, max = MAX_ACTIVITY_LINE): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}
