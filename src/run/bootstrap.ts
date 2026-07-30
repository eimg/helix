/**
 * Shared wiring: config → engine deps, run lifecycle for CLI and server.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig, localPrEnabled, type HelixConfig } from "../config.js";
import { resolveModelRef } from "../config/env.js";
import { runIssue, type EngineDeps } from "../engine/engine.js";
import { EventStream } from "../engine/eventStream.js";
import { DEFAULT_GATE_CONFIG } from "../orchestrator/gates.js";
import { loadWorkflow, type Workflow } from "../orchestrator/workflow.js";
import { LlmOrchestrator } from "../orchestrator/driver.js";
import { OpenRouterProvider, type PiProvider } from "../providers/openrouter.js";
import { loadSpecialists, findHelixDir } from "../agents/loader.js";
import { PiSpecialistSessionFactory } from "../agents/session.js";
import type { Issue, Run, RunContinuation, RunEvent, SpecialistDefinition, Orchestrator, SpecialistSessionFactory } from "../engine/types.js";
import type { RunStore } from "../state/runStore.js";
import { SqliteRunStore } from "../state/runStore.js";
import type { DeliverablePipeline } from "../deliverable/pipeline.js";
import { NoOpDeliverablePipeline } from "../deliverable/pipeline.js";
import { LocalPullRequestDeliverablePipeline } from "../deliverable/localPullRequest.js";
import { notifyIssueTracker } from "../callbacks/issueTracker.js";
import { buildRepoBootstrap } from "../context/bootstrap.js";
import { hasCommit, hasOwnGitDir } from "../inception/git.js";
import { GitRunWorkspaceManager, restorePreparedRunWorkspace, type PreparedRunWorkspace, type RunWorkspaceManager } from "./workspace.js";
import { RunExecutionControl } from "../engine/runControl.js";
import { runSessionRoot } from "./sessionPath.js";

export interface RunContext {
  helixDir: string;
  cwd: string;
  config: HelixConfig;
  /** Resolved orchestrator/manage model (from HELIX_MODEL or shipped default). */
  model: string;
  workflow: Workflow;
  provider: PiProvider;
  specialists: SpecialistDefinition[];
  store: RunStore;
  deliverable: DeliverablePipeline;
  workspace?: RunWorkspaceManager;
  createOrchestrator?: (ctx: RunContext) => Orchestrator;
  createSpecialistFactory?: (ctx: RunContext) => SpecialistSessionFactory;
  issueTrackerFetch?: typeof fetch;
}

export interface RunContextOptions {
  helixDir?: string;
  cwd?: string;
  store?: RunStore;
  deliverable?: DeliverablePipeline;
  workspace?: RunWorkspaceManager;
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
  const model = resolveModelRef().value;
  const provider = opts.provider ?? new OpenRouterProvider();
  const specialists = loadSpecialists(resolve(helixDir, "agents"));
  const store = opts.store ?? new SqliteRunStore(
    resolve(helixDir, "runs.db"),
    resolve(helixDir, "runs"),
  );
  const deliverable = opts.deliverable ?? new NoOpDeliverablePipeline();

  return {
    helixDir,
    cwd,
    config,
    model,
    workflow,
    provider,
    specialists,
    store,
    deliverable,
    workspace: opts.workspace,
    createOrchestrator: opts.createOrchestrator,
    createSpecialistFactory: opts.createSpecialistFactory,
    issueTrackerFetch: opts.issueTrackerFetch,
  };
}

/** Refresh repo-local wiring and agent definitions before a new run starts. */
export function refreshRunContextResources(ctx: RunContext): void {
  ctx.config = loadConfig(ctx.helixDir);
  ctx.workflow = loadWorkflow(ctx.config);
  ctx.specialists = loadSpecialists(resolve(ctx.helixDir, "agents"));
  // Inception may create `.git` after `helix serve` started. Upgrade NoOp → local
  // PR wiring so the first implementation run does not write straight to cwd.
  maybeWireLocalPullRequest(ctx);
}

/**
 * When local PR mode is enabled and the workspace now has a usable base commit,
 * replace a stale NoOp deliverable with isolated worktree + Acme PR registration.
 */
export function maybeWireLocalPullRequest(ctx: RunContext): void {
  if (!localPrEnabled(ctx.config)) return;
  if (!(ctx.deliverable instanceof NoOpDeliverablePipeline)) return;
  if (ctx.workspace) return;
  if (!hasOwnGitDir(ctx.cwd)) return;
  const baseBranch = ctx.config.deliverable?.baseBranch ?? "main";
  if (!hasCommit(ctx.cwd, baseBranch) && !hasCommit(ctx.cwd, "HEAD")) return;

  ctx.deliverable = new LocalPullRequestDeliverablePipeline({
    cwd: ctx.cwd,
    baseBranch,
  });
  ctx.workspace = new GitRunWorkspaceManager(ctx.cwd, baseBranch);
}

export interface ActiveRun {
  runId: string;
  eventStream: EventStream;
  control: RunExecutionControl;
  promise: Promise<Run>;
}

export interface StartRunOptions {
  onEvent?: (run: Run, event: RunEvent) => void;
  skipDeliverable?: boolean;
  /** Allow hosts to subscribe before execution starts, avoiding early-delta loss. */
  eventStream?: EventStream;
  runId?: string;
  parentRunId?: string;
  rootRunId?: string;
  continuation?: RunContinuation;
  /** Continue this exact paused/interrupted run rather than creating a child. */
  resumeRun?: Run;
  control?: RunExecutionControl;
}

export function startRun(ctx: RunContext, issue: Issue, opts: StartRunOptions = {}): ActiveRun {
  refreshRunContextResources(ctx);
  // Capture one immutable resource view for this run. Later Manage saves affect
  // only future runs, including deliverable finalization.
  const config = ctx.config;
  const workflow = ctx.workflow;
  const specialists = ctx.specialists;
  const runId = opts.resumeRun?.id ?? opts.runId ?? randomUUID();
  const eventStream = opts.eventStream ?? new EventStream();
  const control = opts.control ?? new RunExecutionControl();
  const promise = (async (): Promise<Run> => {
    const resumeDelivery = opts.resumeRun?.checkpoint?.phase === "delivery";
    let workspace: PreparedRunWorkspace | undefined;
    const parentRunId = opts.parentRunId ?? opts.resumeRun?.parentRunId;
    const continuation = opts.continuation ?? opts.resumeRun?.continuation;
    const parent = parentRunId ? ctx.store.load(parentRunId) : undefined;
    const reuseBranch =
      continuation?.pullRequestHeadBranch?.trim()
      || parent?.pullRequest?.branch?.trim()
      || undefined;
    const existingPullRequestId =
      continuation?.pullRequestId
      ?? opts.resumeRun?.pullRequest?.number
      ?? parent?.pullRequest?.number;
    if (opts.resumeRun?.implementationWorkspace) {
      try {
        workspace = await restorePreparedRunWorkspace(opts.resumeRun.implementationWorkspace);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        opts.resumeRun.status = "error";
        opts.resumeRun.finishedAt = Date.now();
        opts.resumeRun.deliverableError = message;
        const event: RunEvent = {
          ts: Date.now(),
          type: "run_error",
          summary: `Implementation workspace resume failed: ${message}`,
        };
        opts.resumeRun.events.push(event);
        eventStream.emit(event);
        opts.onEvent?.(opts.resumeRun, event);
        opts.resumeRun.runFile = ctx.store.save(opts.resumeRun);
        return opts.resumeRun;
      }
    } else if (!opts.skipDeliverable && issue.external && ctx.workspace) {
      try {
        workspace = await ctx.workspace.prepare({
          runId,
          issue,
          ...(reuseBranch ? { reuseBranch } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const now = Date.now();
        const events: RunEvent[] = [
          {
            ts: now,
            type: "run_started",
            summary: `Run for ${issue.source}: ${issue.title}`,
          },
          {
            ts: now,
            type: "run_error",
            summary: `Implementation workspace preparation failed: ${message}`,
          },
        ];
        const failedRun: Run = {
          id: runId,
          parentRunId: opts.parentRunId,
          rootRunId: opts.rootRunId,
          continuation: opts.continuation,
          issue,
          startedAt: now,
          finishedAt: now,
          status: "error",
          events,
          results: [],
          approvalStatus: "none",
          deliverableError: message,
        };
        for (const event of events) {
          eventStream.emit(event);
          opts.onEvent?.(failedRun, event);
        }
        failedRun.runFile = ctx.store.save(failedRun);
        return failedRun;
      }
    }
    const runCwd = workspace?.cwd ?? ctx.cwd;
    const runContext = workspace ? { ...ctx, cwd: runCwd } : ctx;
    const orchestrator =
      ctx.createOrchestrator?.(runContext) ??
      new LlmOrchestrator(ctx.provider, workflow, ctx.model, {
        cwd: runCwd,
        helixDir: ctx.helixDir,
        extensions: config.extensions,
      });

    const factory =
      ctx.createSpecialistFactory?.(runContext) ??
      new PiSpecialistSessionFactory(ctx.provider, specialists, {
        cwd: runCwd,
        helixDir: ctx.helixDir,
        defaultModel: ctx.model,
        extensions: config.extensions,
        sessionRoot: runSessionRoot(ctx.helixDir, runId),
      });
    const workspaceNotice = workspace
      ? [
          "",
          "## Helix-managed implementation workspace",
          reuseBranch && workspace.branch === reuseBranch
            ? `You are continuing on existing feature branch \`${workspace.branch}\` in an isolated worktree.`
            : `You are already on feature branch \`${workspace.branch}\` in an isolated worktree.`,
          "Do not create, rename, or switch branches. Implement and run the required self-checks here; Helix will commit any remaining changes before PR registration.",
        ].join("\n")
      : "";
    const repoContext = buildRepoBootstrap(runCwd, config.repoContext) + workspaceNotice;

    const deps: EngineDeps = {
      provider: ctx.provider,
      orchestrator,
      specialistFactory: factory,
      gates: { ...DEFAULT_GATE_CONFIG, maxIterations: workflow.maxIterations },
      eventStream,
      runId,
      parentRunId: opts.parentRunId,
      rootRunId: opts.rootRunId,
      continuation: opts.continuation,
      resumeRun: opts.resumeRun,
      control,
      repoContext,
      implementationWorkspace: workspace
        ? {
            path: workspace.cwd,
            branch: workspace.branch,
            repositoryPath: workspace.repositoryPath,
            baseBranch: workspace.baseBranch,
            baseSha: workspace.baseSha,
          }
        : undefined,
      deferCompletionToDelivery: !opts.skipDeliverable,
      onCheckpoint: (run) => {
        run.runFile = ctx.store.save(run);
      },
      onEvent: (run, event) => {
        opts.onEvent?.(run, event);
        run.runFile = ctx.store.save(run);
      },
    };

    let run: Run;
    if (resumeDelivery && opts.resumeRun) {
      run = opts.resumeRun;
      run.status = "delivering";
      run.finishedAt = undefined;
      recordRunEvent(run, {
        ts: Date.now(),
        type: "run_resumed",
        summary: "Resumed at the deliverable finalization boundary",
        details: { checkpoint: run.checkpoint },
      });
      if ("dispose" in orchestrator && typeof (orchestrator as { dispose?: () => void }).dispose === "function") {
        (orchestrator as { dispose: () => void }).dispose();
      }
    } else {
      try {
        run = await runIssue(issue, deps);
      } finally {
        if ("dispose" in orchestrator && typeof (orchestrator as { dispose?: () => void }).dispose === "function") {
          (orchestrator as { dispose: () => void }).dispose();
        }
      }
    }

    if (!opts.skipDeliverable && run.status === "delivering" && run.checkpoint?.phase === "delivery") {
      const deliveryCheckpoint = run.checkpoint;
      const delivery = deliveryCheckpoint.delivery ?? { status: "pending" as const, attempt: 0 };
      deliveryCheckpoint.delivery = delivery;
      delivery.status = "started";
      delivery.attempt += 1;
      run.deliverableError = undefined;
      deliveryCheckpoint.updatedAt = Date.now();
      recordRunEvent(run, {
        ts: Date.now(),
        type: "delivery_started",
        summary: `Deliverable finalization attempt ${delivery.attempt} started`,
        details: { attempt: delivery.attempt },
      });
      try {
        run = await ctx.deliverable.finalize(run, workflow.mergeGate, {
          cwd: runCwd,
          repositoryPath: workspace?.repositoryPath ?? ctx.cwd,
          branch: workspace?.branch,
          baseBranch: workspace?.baseBranch,
          baseSha: workspace?.baseSha,
          ...(existingPullRequestId !== undefined
            ? { existingPullRequestId }
            : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.deliverableError = message;
        delivery.status = "uncertain";
        run.status = "interrupted";
        recordRunEvent(run, {
          ts: Date.now(),
          type: "run_interrupted",
          summary: `Deliverable finalization stopped unexpectedly: ${message}`,
          details: { checkpoint: run.checkpoint },
        });
        return run;
      }
      delivery.status = "completed";
      deliveryCheckpoint.updatedAt = Date.now();
      recordRunEvent(run, {
        ts: Date.now(),
        type: "delivery_finished",
        summary: run.deliverableError ? `Deliverable finalization finished with a visible error: ${run.deliverableError}` : "Deliverable finalization finished",
        details: { attempt: delivery.attempt, error: run.deliverableError },
      });
      run.status = "done";
      run.finishedAt = Date.now();
      recordRunEvent(run, {
        ts: Date.now(),
        type: "run_done",
        summary: run.finalDecision?.kind === "done" ? run.finalDecision.reason : "Run completed",
        details: {
          deliverable: run.finalDecision?.kind === "done" ? run.finalDecision.deliverable : undefined,
          deliverableError: run.deliverableError,
        },
      });
    }
    if (workspace && run.pullRequest) {
      try {
        await workspace.cleanup();
      } catch {
        // PR identity is already durable. A stale temporary worktree is safe
        // to prune later and must not turn a successful run into a rejection.
      }
    } else if (workspace) {
      run.implementationWorkspace = {
        path: workspace.cwd,
        branch: workspace.branch,
        repositoryPath: workspace.repositoryPath,
        baseBranch: workspace.baseBranch,
        baseSha: workspace.baseSha,
      };
    }

    run.runFile = ctx.store.save(run);
    void notifyIssueTracker(run, { fetchFn: ctx.issueTrackerFetch });
    return run;

    function recordRunEvent(target: Run, event: RunEvent): void {
      target.events.push(event);
      eventStream.emit(event);
      opts.onEvent?.(target, event);
      target.runFile = ctx.store.save(target);
    }
  })();

  return { runId, eventStream, control, promise };
}
