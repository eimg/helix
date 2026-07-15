/**
 * The Helix core loop.
 *
 *   trigger (issue) -> orchestrator (decide) -> specialists (parallel, isolated)
 *                       -> read results -> loop / proceed / escalate / done
 *
 * The engine is decoupled from Express, from the real provider, and from the
 * real specialist session implementation: it takes injected `Provider` and
 * `SpecialistSessionFactory`, so a full run can be exercised with fakes.
 */
import { randomUUID } from "node:crypto";
import type {
  Issue,
  Orchestrator,
  OrchestratorDecision,
  Provider,
  Run,
  RunEvent,
  RunKnowledgeEntry,
  RunContinuation,
  SpecialistCall,
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSession,
  SpecialistSessionFactory,
} from "./types.js";
import { EventStream } from "./eventStream.js";
import { DEFAULT_GATE_CONFIG, enforceIterationCap, isBlockingFailure, type GateConfig } from "../orchestrator/gates.js";
import { prependRepoContext } from "../context/bootstrap.js";
import { formatRunKnowledge, knowledgeFromResult } from "../context/runKnowledge.js";

export interface EngineDeps {
  provider: Provider;
  orchestrator: Orchestrator;
  specialistFactory: SpecialistSessionFactory;
  gates?: GateConfig;
  eventStream?: EventStream;
  onEvent?: (run: Run, event: RunEvent) => void;
  /** Pre-assign run id (server/API). Default: random UUID. */
  runId?: string;
  /**
   * Deterministic repo bootstrap markdown (Phase A). Injected into orchestrator
   * initial prompt and prepended once to every cold specialist session.
   */
  repoContext?: string;
  parentRunId?: string;
  rootRunId?: string;
  continuation?: RunContinuation;
}

export async function runIssue(issue: Issue, deps: EngineDeps): Promise<Run> {
  const events = new EventStream();
  if (deps.eventStream) {
    // bridge: also forward to an externally-supplied stream if given
    const external = deps.eventStream;
    events.subscribe((e) => external.emit(e));
  }

  const run: Run = {
    id: deps.runId ?? randomUUID(),
    parentRunId: deps.parentRunId,
    rootRunId: deps.rootRunId,
    continuation: deps.continuation,
    issue,
    startedAt: Date.now(),
    status: "running",
    events: [],
    results: [],
    knowledge: [],
  };

  const emit = (event: RunEvent, durable = true) => {
    if (durable) run.events.push(event);
    events.emit(event);
    if (durable) deps.onEvent?.(run, event);
  };
  const sessions = new RunSessionPool(deps.specialistFactory);

  try {
    emit({
      ts: Date.now(),
      type: "run_started",
      summary: `Run for ${issue.source}${issue.number != null ? ` #${issue.number}` : ""}: ${issue.title}`,
      details: deps.repoContext
        ? { repoContextChars: deps.repoContext.length }
        : undefined,
    });
    emit({ ts: Date.now(), type: "issue_fetched", summary: issue.url ?? "(inline)", details: { number: issue.number, repo: issue.repo, source: issue.source } });

    const gates = deps.gates ?? DEFAULT_GATE_CONFIG;
    let iteration = 0;

    while (true) {
      const invocationId = randomUUID();
      let orchestratorOutput = "";
      emit({
        ts: Date.now(),
        type: "orchestrator_started",
        summary: `Orchestrator turn ${iteration + 1}`,
        details: { iteration, invocationId },
      });
      let decision: OrchestratorDecision;
      try {
        decision = await deps.orchestrator.decide(
          {
            issue,
            specialists: await listSpecialists(deps.specialistFactory),
            results: run.results,
            iteration,
            repoContext: deps.repoContext,
          },
          {
            onTextDelta: (delta) => {
              orchestratorOutput += delta;
              emit({
                ts: Date.now(),
                type: "orchestrator_output_delta",
                summary: "Orchestrator response",
                details: { iteration, invocationId, delta },
              }, false);
            },
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          ts: Date.now(),
          type: "orchestrator_finished",
          summary: `Orchestrator turn ${iteration + 1}: error`,
          details: { iteration, invocationId, ok: false, output: orchestratorOutput, error: message },
        });
        throw err;
      }
      const fullOutput = orchestratorOutput || JSON.stringify(decision, null, 2);
      emit({
        ts: Date.now(),
        type: "orchestrator_finished",
        summary: `Orchestrator turn ${iteration + 1}: finished`,
        details: { iteration, invocationId, ok: true, output: fullOutput, decision },
      });
      decision = enforceIterationCap(decision, iteration, gates);
      emit({
        ts: Date.now(),
        type: "orchestrator_decided",
        summary: describeDecision(decision),
        details: { iteration, invocationId, decision },
      });

      if (decision.kind === "run") {
        const newResults = await runSpecialists(
          decision.specialists,
          deps.specialistFactory,
          sessions,
          run.knowledge ?? [],
          deps.repoContext,
          emit,
        );
        run.results.push(...newResults);
        run.knowledge?.push(...newResults.map(knowledgeFromResult));
        iteration++;
        continue;
      }

      if (decision.kind === "escalate") {
        run.status = "escalated";
        run.finalDecision = decision;
        emit({ ts: Date.now(), type: "run_escalated", summary: decision.reason });
        break;
      }

      // done — but never if a specialist failed. That is a hard gate: the
      // orchestrator cannot declare success over an unverified run.
      if (isBlockingFailure(run.results)) {
        run.status = "escalated";
        const blocking = run.results.filter((r) => !r.ok);
        const escalated: OrchestratorDecision = {
          kind: "escalate",
          reason: `Orchestrator declared done, but ${blocking.length} specialist(s) failed: ${blocking.map((r) => r.specialist).join(", ")}`,
        };
        run.finalDecision = escalated;
        emit({ ts: Date.now(), type: "gate_blocked", summary: escalated.reason, details: { blocking: blocking.map((r) => r.specialist) } });
        emit({ ts: Date.now(), type: "run_escalated", summary: escalated.reason });
        break;
      }

      run.status = "done";
      run.finalDecision = decision;
      emit({ ts: Date.now(), type: "run_done", summary: decision.reason, details: { deliverable: decision.deliverable } });
      break;
    }
  } catch (err) {
    run.status = "error";
    const message = err instanceof Error ? err.message : String(err);
    emit({ ts: Date.now(), type: "run_error", summary: message });
  } finally {
    await sessions.dispose();
    run.finishedAt = Date.now();
  }

  return run;
}

async function listSpecialists(factory: SpecialistSessionFactory): Promise<SpecialistDefinition[]> {
  return definitionsOf(factory);
}

/**
 * Sessions are created from definitions discovered by the factory. The factory
 * exposes them as `definitions` (both real and stub factories do). This is the
 * one place that contract is asserted, instead of scattered casts.
 */
function definitionsOf(factory: SpecialistSessionFactory): SpecialistDefinition[] {
  return (factory as SpecialistSessionFactory & { definitions?: SpecialistDefinition[] }).definitions ?? [];
}

async function runSpecialists(
  calls: SpecialistCall[],
  factory: SpecialistSessionFactory,
  sessions: RunSessionPool,
  knowledge: RunKnowledgeEntry[],
  repoContext: string | undefined,
  emit: (e: RunEvent, durable?: boolean) => void,
): Promise<SpecialistResult[]> {
  // allSettled: one specialist throwing must not abandon its siblings or kill
  // the run. A rejection becomes an ok:false result; the run continues and the
  // orchestrator gets to react to the failure.
  const settled = await Promise.allSettled(
    calls.map(async (call): Promise<SpecialistResult> => {
      const def = definitionsOf(factory).find((d) => d.name === call.specialist);
      if (!def) {
        return {
          specialist: call.specialist,
          task: call.task,
          ok: false,
          output: "",
          error: `Unknown specialist: ${call.specialist}`,
        };
      }
      try {
        return await sessions.use(call.specialist, def, async (session, cold) => {
          const invocationId = randomUUID();
          const task = prepareSpecialistTask(call.task, cold ? repoContext : undefined, knowledge);
          emit({
            ts: Date.now(),
            type: "specialist_started",
            summary: call.specialist,
            details: { specialist: call.specialist, task: call.task, invocationId, coldSession: cold },
          });
          try {
            const result = await session.run(task, {
              onActivity: (line) => {
                if (line.kind === "text_delta") {
                  emit({
                    ts: Date.now(),
                    type: "specialist_output_delta",
                    summary: call.specialist,
                    details: { specialist: call.specialist, invocationId, delta: line.line },
                  }, false);
                  return;
                }
                emit({
                  ts: Date.now(),
                  type: "specialist_activity",
                  summary: `${call.specialist}: ${line.line.slice(0, 80)}`,
                  details: {
                    specialist: call.specialist,
                    invocationId,
                    kind: line.kind,
                    line: line.line,
                    toolName: line.toolName,
                    phase: line.phase,
                    isError: line.isError,
                  },
                });
              },
            });
            result.task = call.task;
            emit({
              ts: Date.now(),
              type: "specialist_finished",
              summary: `${call.specialist}: ${result.ok ? "ok" : "fail"}`,
              details: {
                specialist: call.specialist,
                invocationId,
                ok: result.ok,
                output: result.output,
                error: result.error,
              },
            });
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emit({
              ts: Date.now(),
              type: "specialist_finished",
              summary: `${call.specialist}: error`,
              details: { specialist: call.specialist, invocationId, ok: false, output: "", error: message },
            });
            return {
              specialist: call.specialist,
              task: call.task,
              ok: false,
              output: "",
              error: `session threw: ${message}`,
            };
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          specialist: call.specialist,
          task: call.task,
          ok: false,
          output: "",
          error: `failed to create or acquire session: ${message}`,
        };
      }
    }),
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          specialist: calls[i].specialist,
          task: calls[i].task,
          ok: false,
          output: "",
          error: `unhandled: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        },
  );
}

class RunSessionPool {
  private readonly sessions = new Map<string, Promise<SpecialistSession>>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly factory: SpecialistSessionFactory) {}

  async use<T>(
    name: string,
    def: SpecialistDefinition,
    fn: (session: SpecialistSession, cold: boolean) => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(name, tail);
    await previous;

    const cold = !this.sessions.has(name);
    let sessionPromise = this.sessions.get(name);
    if (!sessionPromise) {
      sessionPromise = this.factory.create(def);
      this.sessions.set(name, sessionPromise);
    }

    try {
      return await fn(await sessionPromise, cold);
    } catch (err) {
      if (cold) this.sessions.delete(name);
      throw err;
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }

  async dispose(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    for (const settled of sessions) {
      if (settled.status !== "fulfilled") continue;
      try {
        settled.value.dispose();
      } catch {
        // disposal must not mask the run result
      }
    }
    this.sessions.clear();
    this.tails.clear();
  }
}

function prepareSpecialistTask(
  task: string,
  repoContext: string | undefined,
  knowledge: RunKnowledgeEntry[],
): string {
  let prepared = repoContext ? prependRepoContext(task, repoContext) : task;
  const handoff = formatRunKnowledge(knowledge);
  if (handoff) {
    prepared = `## Shared run knowledge\n${handoff}\n\n## Current task\n${prepared}`;
  }
  return prepared;
}

function describeDecision(d: OrchestratorDecision): string {
  switch (d.kind) {
    case "run":
      return `run [${d.specialists.map((s) => s.specialist).join(", ")}] — ${d.reason}`;
    case "done":
      return `done — ${d.reason}`;
    case "escalate":
      return `escalate — ${d.reason}`;
  }
}

// re-export for callers
export { EventStream };
