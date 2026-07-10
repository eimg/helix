/**
 * The LLM half of the hybrid orchestrator.
 *
 * It is an in-process pi session (the configured orchestrator model) that,
 * given the issue + available specialists + results so far + the workflow
 * rails, emits a structured decision (run / done / escalate). The workflow is
 * described in its system prompt as *rails*; the LLM adapts to the task.
 *
 * Hard safety (iteration cap, etc.) is enforced by deterministic code in
 * gates.ts — this driver only *proposes* decisions.
 *
 * Output contract: the model is asked to reply with a single JSON object. We
 * parse it defensively (first {...} block) and validate the shape. On any
 * parse failure we fall back to `escalate` rather than silently mis-routing.
 */
import type { Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type {
  Issue,
  Orchestrator,
  OrchestratorDecision,
  OrchestratorInput,
  SpecialistCall,
  SpecialistDefinition,
} from "../engine/types.js";
import type { PiProvider } from "../providers/openrouter.js";
import { buildSessionLoader } from "../agents/loaderBuilder.js";
import { describeWorkflow, type Workflow } from "./workflow.js";

const SYSTEM_PROMPT = `You are Helix's orchestrator. You coordinate specialist agents to drive a GitHub issue to a deliverable.

You reason WITHIN a workflow defined as rails (a default specialist sequence and loop rules). You may follow it, skip a step, reorder, or parallelize — whatever best serves the task. You are the ONLY coordination point: specialists never talk to each other; you compose each specialist's handoff context from prior results.

Reply with ONE JSON object and nothing else. Schema:
{
  "kind": "run" | "done" | "escalate",
  "reason": "why",
  "specialists": [{ "specialist": "<name>", "task": "<the full handoff prompt for that specialist>" }],  // required when kind=run
  "deliverable": "..."  // optional, when kind=done
}

Rules:
- kind=run: invoke one or more specialists in parallel. Each "task" must be self-contained (include relevant context from prior results) since specialists cannot see each other.
- kind=done: only when the work is complete and verified. Include "deliverable".
- kind=escalate: when blocked, too risky, or needs a human.
- Never invent specialist names; use only those listed in the available specialists.
- When a Repo bootstrap section is present, treat it as ground truth for layout/scripts/docs. Tell specialists to use it and only explore gaps — do not ask them to rediscover the whole tree.`;

export interface LlmOrchestratorOptions {
  cwd?: string;
  helixDir?: string;
  extensions?: { enabled?: boolean; paths?: string[] };
}

export class LlmOrchestrator implements Orchestrator {
  private readonly provider: PiProvider;
  private readonly workflow: Workflow;
  private readonly cwd: string;
  private readonly helixDir: string;
  private readonly extensions: { enabled?: boolean; paths?: string[] } | undefined;
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  constructor(provider: PiProvider, workflow: Workflow, modelRef: string, opts: LlmOrchestratorOptions = {}) {
    this.provider = provider;
    this.workflow = workflow;
    this.cwd = opts.cwd ?? process.cwd();
    this.helixDir = opts.helixDir ?? resolve(this.cwd, ".helix");
    this.extensions = opts.extensions;
    this._modelRef = modelRef;
  }
  private _modelRef: string;

  private async ensureSession(): Promise<NonNullable<LlmOrchestrator["session"]>> {
    if (this.session) return this.session;
    const model = await this.provider.resolveModel(this._modelRef);
    const loader = buildSessionLoader({
      cwd: this.cwd,
      helixDir: this.helixDir,
      extensions: this.extensions,
      systemPromptOverride: SYSTEM_PROMPT,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      model,
      thinkingLevel: "off",
      tools: [], // pure reasoning — no tools
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      authStorage: this.provider.authStorage,
      modelRegistry: this.provider.modelRegistry,
    });
    this.session = session;
    return session;
  }

  async decide(input: OrchestratorInput): Promise<OrchestratorDecision> {
    const session = await this.ensureSession();
    const prompt = buildPrompt(input, this.workflow);

    let promptError: string | undefined;
    try {
      await session.prompt(prompt);
    } catch (err) {
      promptError = err instanceof Error ? err.message : String(err);
    }

    const messages = session.messages as Message[];
    const assistant = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");

    // Surface LLM errors — without this, a failed model call (auth, rate limit,
    // network) produces an empty assistant message, and the driver reports
    // "unparseable decision" instead of the actual error.
    if (promptError) {
      return { kind: "escalate", reason: `Orchestrator LLM call failed: ${promptError}` };
    }
    if (!assistant) {
      return { kind: "escalate", reason: "Orchestrator produced no assistant response." };
    }
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      const detail = assistant.errorMessage ?? assistant.stopReason;
      return { kind: "escalate", reason: `Orchestrator LLM error (${assistant.stopReason}): ${detail}` };
    }

    const text = finalAssistantText(messages);
    const decision = sanitizeDecision(text, input.specialists);
    if (!decision) {
      return {
        kind: "escalate",
        reason: `Orchestrator returned unparseable decision. Raw output:\n${text.slice(0, 500)}`,
      };
    }
    return decision;
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
  }
}

function buildPrompt(input: OrchestratorInput, workflow: Workflow): string {
  const { issue, specialists, results, iteration, repoContext } = input;
  const specialistList = specialists
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  const resultsBlock =
    results.length === 0
      ? "(none yet)"
      : results
          .map(
            (r) =>
              `### ${r.specialist} ${r.ok ? "(ok)" : "(FAILED)"}\nTask: ${r.task}\nOutput:\n${r.output}`,
          )
          .join("\n\n");

  const issueHeader = issue.number != null ? `## Issue #${issue.number}: ${issue.title}` : `## Issue: ${issue.title}`;
  const sourceLines = [
    issue.url ? issue.url : null,
    issue.repo ? `Repo: ${issue.repo}` : null,
    `Source: ${issue.source}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
  ].filter(Boolean).join("\n");

  const bootstrapBlock = repoContext ? `\n${repoContext}\n` : "";

  return `${issueHeader}
${sourceLines}

${issue.body}
${bootstrapBlock}
## Workflow rails
${describeWorkflow(workflow)}

## Available specialists
${specialistList}

## Results so far (iteration ${iteration})
${resultsBlock}

## Your decision
Reply with ONE JSON object per the schema. If you invoke specialists, each task must be a complete, self-contained handoff prompt.`;
}

interface RawDecision {
  kind?: string;
  reason?: string;
  specialists?: Array<{ specialist?: string; task?: string }>;
  deliverable?: string;
}

/** Extract the first balanced {...} block from text. */
function extractJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function sanitizeDecision(text: string, available: SpecialistDefinition[]): OrchestratorDecision | undefined {
  const json = extractJson(text);
  if (!json) return undefined;
  let raw: RawDecision;
  try {
    raw = JSON.parse(json) as RawDecision;
  } catch {
    return undefined;
  }
  if (!raw.kind) return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  const known = new Set(available.map((s) => s.name));

  if (raw.kind === "run") {
    const calls: SpecialistCall[] = [];
    for (const c of raw.specialists ?? []) {
      if (!c.specialist || !known.has(c.specialist)) return undefined;
      calls.push({ specialist: c.specialist, task: typeof c.task === "string" ? c.task : "" });
    }
    if (calls.length === 0) return undefined;
    return { kind: "run", specialists: calls, reason };
  }
  if (raw.kind === "done") {
    return { kind: "done", reason, deliverable: raw.deliverable };
  }
  if (raw.kind === "escalate") {
    return { kind: "escalate", reason };
  }
  return undefined;
}

function finalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      return m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
    }
  }
  return "";
}

// referenced for type narrowing
export type { Issue, SpecialistDefinition, Message, AssistantMessage };
