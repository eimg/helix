/**
 * Real specialist agent layer: an isolated in-process pi session per
 * specialist, with its own model, system prompt, and tools.
 *
 * This is the production counterpart to `stubSession.ts`. The engine treats
 * both identically via `SpecialistSessionFactory`; tests use the stub, the CLI
 * uses this one.
 *
 * One process, one session per specialist invocation, parallel via Promise.all
 * in the engine — no subprocesses (per AGENTS.md v1 decision).
 */
import type { Api, Model, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSession,
  SpecialistSessionFactory,
} from "../engine/types.js";
import type { PiProvider } from "../providers/openrouter.js";

export interface PiSpecialistFactoryOptions {
  /** Working directory specialists operate in. Default process.cwd(). */
  cwd?: string;
}

export class PiSpecialistSessionFactory implements SpecialistSessionFactory {
  /** Exposed so the engine can enumerate available specialists. */
  readonly definitions: SpecialistDefinition[];
  private readonly provider: PiProvider;
  private readonly cwd: string;

  constructor(provider: PiProvider, definitions: SpecialistDefinition[], opts: PiSpecialistFactoryOptions = {}) {
    this.provider = provider;
    this.definitions = definitions;
    this.cwd = opts.cwd ?? process.cwd();
  }

  async create(def: SpecialistDefinition): Promise<SpecialistSession> {
    const model = def.model ? await this.provider.resolveModel(def.model) : undefined;
    if (!model) throw new Error(`Specialist "${def.name}" has no resolvable model (${def.model ?? "undefined"})`);

    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: () => def.systemPrompt,
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

  async run(task: string): Promise<SpecialistResult> {
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
