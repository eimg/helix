/**
 * Shared wiring: config → engine deps, run lifecycle for CLI and server.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig, type HelixConfig } from "../config.js";
import { applyEnvModelToSpecialists } from "../config/env.js";
import { runIssue, type EngineDeps } from "../engine/engine.js";
import { EventStream } from "../engine/eventStream.js";
import { DEFAULT_GATE_CONFIG } from "../orchestrator/gates.js";
import { loadWorkflow, type Workflow } from "../orchestrator/workflow.js";
import { LlmOrchestrator } from "../orchestrator/driver.js";
import { OpenRouterProvider, type PiProvider } from "../providers/openrouter.js";
import { loadSpecialists, findHelixDir } from "../agents/loader.js";
import { PiSpecialistSessionFactory } from "../agents/session.js";
import type { Issue, Run, RunEvent, SpecialistDefinition, Orchestrator, SpecialistSessionFactory } from "../engine/types.js";
import type { RunStore } from "../state/runStore.js";
import { FileRunStore } from "../state/runStore.js";
import type { DeliverablePipeline } from "../deliverable/pipeline.js";
import { NoOpDeliverablePipeline } from "../deliverable/pipeline.js";
import { notifyIssueTracker } from "../callbacks/issueTracker.js";
import { buildRepoBootstrap } from "../context/bootstrap.js";

export interface RunContext {
  helixDir: string;
  cwd: string;
  config: HelixConfig;
  workflow: Workflow;
  provider: PiProvider;
  specialists: SpecialistDefinition[];
  store: RunStore;
  deliverable: DeliverablePipeline;
  createOrchestrator?: (ctx: RunContext) => Orchestrator;
  createSpecialistFactory?: (ctx: RunContext) => SpecialistSessionFactory;
  issueTrackerFetch?: typeof fetch;
}

export interface RunContextOptions {
  helixDir?: string;
  cwd?: string;
  store?: RunStore;
  deliverable?: DeliverablePipeline;
  provider?: PiProvider;
  issueTrackerFetch?: typeof fetch;
  createOrchestrator?: (ctx: RunContext) => Orchestrator;
  createSpecialistFactory?: (ctx: RunContext) => SpecialistSessionFactory;
}

export function createRunContext(opts: RunContextOptions = {}): RunContext {
  const helixDir = opts.helixDir ?? findHelixDir(opts.cwd ?? process.cwd());
  // Repo root is the parent of `.helix/` unless the caller overrides cwd.
  const cwd = opts.cwd ?? resolve(helixDir, "..");
  const config = loadConfig(helixDir);
  const workflow = loadWorkflow(config);
  const provider = opts.provider ?? new OpenRouterProvider({
    apiKeyEnv: config.provider.apiKeyEnv ?? "OPENROUTER_API_KEY",
    inheritPi: config.inheritPi,
  });
  const specialists = applyEnvModelToSpecialists(loadSpecialists(resolve(helixDir, "agents")));
  const store = opts.store ?? new FileRunStore(resolve(helixDir, "runs"));
  const deliverable = opts.deliverable ?? new NoOpDeliverablePipeline();

  return {
    helixDir,
    cwd,
    config,
    workflow,
    provider,
    specialists,
    store,
    deliverable,
    createOrchestrator: opts.createOrchestrator,
    createSpecialistFactory: opts.createSpecialistFactory,
    issueTrackerFetch: opts.issueTrackerFetch,
  };
}

export interface ActiveRun {
  runId: string;
  eventStream: EventStream;
  promise: Promise<Run>;
}

export interface StartRunOptions {
  onEvent?: (run: Run, event: RunEvent) => void;
  skipDeliverable?: boolean;
}

export function startRun(ctx: RunContext, issue: Issue, opts: StartRunOptions = {}): ActiveRun {
  const runId = randomUUID();
  const eventStream = new EventStream();
  const orchestrator =
    ctx.createOrchestrator?.(ctx) ??
    new LlmOrchestrator(ctx.provider, ctx.workflow, ctx.config.orchestrator.model, {
      cwd: ctx.cwd,
      helixDir: ctx.helixDir,
      inheritPi: ctx.config.inheritPi,
      extensions: ctx.config.extensions,
    });

  const factory =
    ctx.createSpecialistFactory?.(ctx) ??
    new PiSpecialistSessionFactory(ctx.provider, ctx.specialists, {
      cwd: ctx.cwd,
      helixDir: ctx.helixDir,
      inheritPi: ctx.config.inheritPi,
      extensions: ctx.config.extensions,
    });

  const repoContext = buildRepoBootstrap(ctx.cwd, ctx.config.repoContext);

  const deps: EngineDeps = {
    provider: ctx.provider,
    orchestrator,
    specialistFactory: factory,
    gates: { ...DEFAULT_GATE_CONFIG, maxIterations: ctx.workflow.maxIterations },
    eventStream,
    runId,
    repoContext,
    onEvent: (run, event) => {
      opts.onEvent?.(run, event);
      run.runFile = ctx.store.save(run);
    },
  };

  const promise = (async (): Promise<Run> => {
    let run: Run;
    try {
      run = await runIssue(issue, deps);
    } finally {
      if ("dispose" in orchestrator && typeof (orchestrator as { dispose?: () => void }).dispose === "function") {
        (orchestrator as { dispose: () => void }).dispose();
      }
    }

    if (!opts.skipDeliverable && run.status === "done") {
      run = await ctx.deliverable.finalize(run, ctx.workflow.mergeGate);
    }

    run.runFile = ctx.store.save(run);
    void notifyIssueTracker(run, { fetchFn: ctx.issueTrackerFetch });
    return run;
  })();

  return { runId, eventStream, promise };
}
