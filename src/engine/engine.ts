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
  SpecialistCall,
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSession,
  SpecialistSessionFactory,
} from "./types.js";
import { EventStream } from "./eventStream.js";
import { DEFAULT_GATE_CONFIG, enforceIterationCap, isBlockingFailure, type GateConfig } from "../orchestrator/gates.js";
import { prependRepoContext } from "../context/bootstrap.js";

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
   * prompts and prepended to the first specialist wave's tasks.
   */
  repoContext?: string;
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
    issue,
    startedAt: Date.now(),
    status: "running",
    events: [],
    results: [],
  };

  const emit = (event: RunEvent) => {
    run.events.push(event);
    events.emit(event);
    deps.onEvent?.(run, event);
  };

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
    let injectedBootstrap = false;

    while (true) {
      let decision: OrchestratorDecision = await deps.orchestrator.decide({
        issue,
        specialists: await listSpecialists(deps.specialistFactory),
        results: run.results,
        iteration,
        repoContext: deps.repoContext,
      });
      decision = enforceIterationCap(decision, iteration, gates);
      emit({
        ts: Date.now(),
        type: "orchestrator_decided",
        summary: describeDecision(decision),
        details: { iteration, decision },
      });

      if (decision.kind === "run") {
        const calls =
          !injectedBootstrap && deps.repoContext
            ? decision.specialists.map((c) => ({
                ...c,
                task: prependRepoContext(c.task, deps.repoContext),
              }))
            : decision.specialists;
        if (!injectedBootstrap && deps.repoContext) injectedBootstrap = true;
        const newResults = await runSpecialists(calls, deps.specialistFactory, emit);
        run.results.push(...newResults);
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
  emit: (e: RunEvent) => void,
): Promise<SpecialistResult[]> {
  const sessions: SpecialistSession[] = [];
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
      let session: SpecialistSession;
      try {
        session = await factory.create(def);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          specialist: call.specialist,
          task: call.task,
          ok: false,
          output: "",
          error: `failed to create session: ${message}`,
        };
      }
      sessions.push(session);
      const invocationId = Date.now();
      emit({
        ts: Date.now(),
        type: "specialist_started",
        summary: call.specialist,
        details: { specialist: call.specialist, task: call.task, invocationId },
      });
      try {
        const result = await session.run(call.task, {
          onActivity: (line) => {
            emit({
              ts: Date.now(),
              type: "specialist_activity",
              summary: `${call.specialist}: ${line.line.slice(0, 80)}`,
              details: {
                specialist: call.specialist,
                invocationId,
                kind: line.kind,
                line: line.line,
              },
            });
          },
        });
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
    }),
  );
  // dispose all sessions that were created, regardless of outcome
  for (const session of sessions) {
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
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
