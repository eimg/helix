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
  RunCheckpointInvocation,
  RunEvent,
  RunKnowledgeEntry,
  RunContinuation,
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSession,
  SpecialistSessionFactory,
} from "./types.js";
import { EventStream } from "./eventStream.js";
import { DEFAULT_GATE_CONFIG, enforceIterationCap, isBlockingFailure, type GateConfig } from "../orchestrator/gates.js";
import { prependRepoContext } from "../context/bootstrap.js";
import { formatRunKnowledge, knowledgeFromResult } from "../context/runKnowledge.js";
import type { RunExecutionControl } from "./runControl.js";

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
  /** Existing durable state when continuing the same paused/interrupted run. */
  resumeRun?: Run;
  control?: RunExecutionControl;
  /** Persist a safe boundary even when no user-facing event is emitted. */
  onCheckpoint?: (run: Run) => void;
  implementationWorkspace?: Run["implementationWorkspace"];
  /** Keep successful execution resumable until the host finalizes its deliverable. */
  deferCompletionToDelivery?: boolean;
}

export async function runIssue(issue: Issue, deps: EngineDeps): Promise<Run> {
  const events = new EventStream();
  if (deps.eventStream) {
    // bridge: also forward to an externally-supplied stream if given
    const external = deps.eventStream;
    events.subscribe((e) => external.emit(e));
  }

  const resuming = deps.resumeRun !== undefined;
  const run: Run = deps.resumeRun ?? {
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
    checkpoint: { version: 1, phase: "orchestrator", iteration: 0, updatedAt: Date.now() },
    implementationWorkspace: deps.implementationWorkspace,
  };
  run.status = "running";
  run.finishedAt = undefined;
  run.knowledge ??= [];
  run.checkpoint ??= {
    version: 1,
    phase: "orchestrator",
    iteration: inferIteration(run),
    updatedAt: Date.now(),
  };

  const emit = (event: RunEvent, durable = true) => {
    if (durable) run.events.push(event);
    events.emit(event);
    if (durable) deps.onEvent?.(run, event);
  };
  const sessions = new RunSessionPool(deps.specialistFactory);
  let pauseEventEmitted = false;
  const unbindControl = deps.control?.bind((reason) => {
    if (pauseEventEmitted || run.status !== "running") return;
    pauseEventEmitted = true;
    run.status = "pause_requested";
    emit({ ts: Date.now(), type: "run_pause_requested", summary: reason });
  });

  const checkpoint = () => {
    if (deps.control?.pauseRequested && !pauseEventEmitted && run.status === "running") {
      pauseEventEmitted = true;
      run.status = "pause_requested";
      emit({ ts: Date.now(), type: "run_pause_requested", summary: deps.control.pauseReason });
    }
    if (run.checkpoint) run.checkpoint.updatedAt = Date.now();
    deps.onCheckpoint?.(run);
  };

  const pauseAtBoundary = (): boolean => {
    if (!deps.control?.pauseRequested) return false;
    run.status = "paused";
    emit({
      ts: Date.now(),
      type: "run_paused",
      summary: `${deps.control.pauseReason}; resume will continue at the saved ${run.checkpoint?.phase ?? "orchestration"} boundary`,
      details: { checkpoint: run.checkpoint },
    });
    return true;
  };

  try {
    if (resuming) {
      emit({
        ts: Date.now(),
        type: "run_resumed",
        summary: `Resumed at ${run.checkpoint.phase} boundary for turn ${run.checkpoint.iteration + 1}`,
        details: { checkpoint: run.checkpoint },
      });
    } else {
      emit({
        ts: Date.now(),
        type: "run_started",
        summary: `Run for ${issue.source}${issue.number != null ? ` #${issue.number}` : ""}: ${issue.title}`,
        details: deps.repoContext
          ? { repoContextChars: deps.repoContext.length }
          : undefined,
      });
      emit({ ts: Date.now(), type: "issue_fetched", summary: issue.url ?? "(inline)", details: { number: issue.number, repo: issue.repo, source: issue.source } });
      checkpoint();
    }

    const gates = deps.gates ?? DEFAULT_GATE_CONFIG;

    while (true) {
      if (pauseAtBoundary()) break;

      if (run.checkpoint.phase === "specialists") {
        const pending = (run.checkpoint.invocations ?? []).filter((item) => item.status === "pending");
        await runSpecialists(
          pending,
          deps.specialistFactory,
          sessions,
          run.knowledge ?? [],
          deps.repoContext,
          emit,
          (invocation) => {
            if (invocation.status !== "pending") return;
            invocation.status = "started";
            checkpoint();
          },
          (invocation, result) => {
            if (invocation.status === "completed") return;
            invocation.status = "completed";
            run.results.push(result);
            run.knowledge?.push(knowledgeFromResult(result));
            checkpoint();
          },
        );
        const completedIteration: number = run.checkpoint.iteration;
        run.checkpoint = {
          version: 1,
          phase: "orchestrator",
          iteration: completedIteration + 1,
          updatedAt: Date.now(),
        };
        checkpoint();
        continue;
      }

      const iteration: number = run.checkpoint.iteration;
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
        run.checkpoint = {
          version: 1,
          phase: "specialists",
          iteration,
          updatedAt: Date.now(),
          decision,
          invocations: decision.specialists.map((call) => ({
            id: randomUUID(),
            specialist: call.specialist,
            task: call.task,
            status: "pending",
          })),
        };
        checkpoint();
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

      run.finalDecision = decision;
      if (deps.deferCompletionToDelivery) {
        run.status = "delivering";
        run.checkpoint = {
          version: 1,
          phase: "delivery",
          iteration,
          updatedAt: Date.now(),
          delivery: { status: "pending", attempt: 0 },
        };
        emit({ ts: Date.now(), type: "delivery_pending", summary: "Execution complete; deliverable finalization is pending" });
      } else {
        run.status = "done";
        emit({ ts: Date.now(), type: "run_done", summary: decision.reason, details: { deliverable: decision.deliverable } });
      }
      break;
    }
  } catch (err) {
    run.status = "error";
    const message = err instanceof Error ? err.message : String(err);
    emit({ ts: Date.now(), type: "run_error", summary: message });
  } finally {
    unbindControl?.();
    await sessions.dispose();
    if (run.status === "done" || run.status === "escalated" || run.status === "error") {
      run.finishedAt = Date.now();
    }
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
  calls: RunCheckpointInvocation[],
  factory: SpecialistSessionFactory,
  sessions: RunSessionPool,
  knowledge: RunKnowledgeEntry[],
  repoContext: string | undefined,
  emit: (e: RunEvent, durable?: boolean) => void,
  onStart: (invocation: RunCheckpointInvocation) => void,
  onComplete: (invocation: RunCheckpointInvocation, result: SpecialistResult) => void,
): Promise<void> {
  // allSettled: one specialist throwing must not abandon its siblings or kill
  // the run. A rejection becomes an ok:false result; the run continues and the
  // orchestrator gets to react to the failure.
  const settled = await Promise.allSettled(
    calls.map(async (call): Promise<SpecialistResult> => {
      onStart(call);
      const def = definitionsOf(factory).find((d) => d.name === call.specialist);
      if (!def) {
        const result: SpecialistResult = {
          invocationId: call.id,
          specialist: call.specialist,
          task: call.task,
          ok: false,
          output: "",
          error: `Unknown specialist: ${call.specialist}`,
        };
        onComplete(call, result);
        return result;
      }
      try {
        return await sessions.use(call.specialist, def, async (session, cold) => {
          const invocationId = call.id;
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
            result.invocationId = invocationId;
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
            onComplete(call, result);
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emit({
              ts: Date.now(),
              type: "specialist_finished",
              summary: `${call.specialist}: error`,
              details: { specialist: call.specialist, invocationId, ok: false, output: "", error: message },
            });
            const result: SpecialistResult = {
              invocationId,
              specialist: call.specialist,
              task: call.task,
              ok: false,
              output: "",
              error: `session threw: ${message}`,
            };
            onComplete(call, result);
            return result;
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result: SpecialistResult = {
          invocationId: call.id,
          specialist: call.specialist,
          task: call.task,
          ok: false,
          output: "",
          error: `failed to create or acquire session: ${message}`,
        };
        onComplete(call, result);
        return result;
      }
    }),
  );
  for (const [index, item] of settled.entries()) {
    if (item.status === "fulfilled") continue;
    const call = calls[index];
    onComplete(call, {
      invocationId: call.id,
      specialist: call.specialist,
      task: call.task,
      ok: false,
      output: "",
      error: `unhandled: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`,
    });
  }
}

function inferIteration(run: Run): number {
  return run.events.filter((event) =>
    event.type === "orchestrator_decided"
    && (event.details?.decision as { kind?: string } | undefined)?.kind === "run"
  ).length;
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
