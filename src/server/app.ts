/**
 * Express host — consumer of the engine API (M2).
 *
 * POST /runs          start a run (inline or GitHub issue number)
 * POST /runs/:id/continuations   start an externally triggered linked child run
 * POST /runs/:id/pause | /resume   park or continue the same durable run
 * GET  /runs          list run summaries (newest first)
 * GET  /runs/:id      run state snapshot
 * DELETE /runs/:id    delete a finished run (testing cleanup)
 * GET  /runs/:id/events   SSE stream of RunEvents
 * POST /runs/:id/approve | /reject   human merge gate decisions
 * POST /pr-reviews     start an independent, SHA-bound local PR review
 * GET  /pr-reviews     list PR-control reviews
 * GET  /pr-reviews/:id inspect one PR-control review
 * GET  /pr-reviews/:id/events stream durable PR-review lifecycle events
 * POST /local-prs/merge  human-initiated local Git merge for a reviewed head
 *
 * Manage (experimental):
 * POST /manage/sessions, GET /manage/sessions/:id, SSE events, apply, discard
 * GET  /manage/agents | /manage/pr-agents | /manage/inception-agents
 * GET  /manage/skills | /manage/inception-skills | /manage/workflow
 * PUT  /manage/workflow   update the ordered default workflow
 *
 * Config (observability):
 * GET  /config            Config tab UI
 * GET  /config/snapshot   resolved runtime config + provenance
 *
 * Workspace / inception:
 * GET  /workspace         git/empty status + bootstrap/PR availability
 * GET  /bootstrap/export-catalog  proxy catalog list (soft export contract)
 * GET  /bootstrap/export-catalog/status  catalog reachability (online/offline)
 * POST /bootstrap         dry-run or execute empty-workspace bootstrap
 */
import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { attachHmr, webAssets, webFromSource, webIndex } from "./webAssets.js";
import type { RunContext } from "../run/bootstrap.js";
import { refreshRunContextResources, startRun } from "../run/bootstrap.js";
import type { Issue, Run, RunContinuation, RunEvent } from "../engine/types.js";
import { EventStream } from "../engine/eventStream.js";
import { RunExecutionControl } from "../engine/runControl.js";
import { inlineIssue } from "../triggers/inline.js";
import { GitHubTrigger } from "../triggers/github.js";
import { approveRun, rejectRun } from "../deliverable/pipeline.js";
import { mergeLocalPullRequest } from "../deliverable/localMerge.js";
import type { PullRequestCreator } from "../deliverable/pr.js";
import { HELIX_DEFAULT_PORT } from "../config/defaults.js";
import { buildConfigSnapshot } from "../config/snapshot.js";
import { ManageService } from "../manage/service.js";
import type { ManageEvent } from "../manage/types.js";
import { externalFromHeaders, parseIssueExternal } from "../callbacks/issueTracker.js";
import { loadManagedWorkflow, saveManagedWorkflow } from "../manage/workflow.js";
import { buildContinuationIssue } from "../run/continuation.js";
import { runSessionRoot } from "../run/sessionPath.js";
import type { RunStore } from "../state/runStore.js";
import type { PullRequestControlService } from "../pr-control/service.js";
import type { PullRequestReviewEvent, PullRequestReviewRequest } from "../pr-control/types.js";
import {
  getWorkspaceStatus,
  runBootstrap,
  type BootstrapAcceptedResult,
  type BootstrapExecuteResult,
  type BootstrapPreview,
} from "../inception/service.js";
import { listExportCatalog } from "../inception/pickup.js";
import { probeExportCatalogStatus } from "../inception/catalogStatus.js";
import type { CreateBootstrapSpecialistFactory } from "../inception/runner.js";
import {
  authenticateRequests,
  authorizeHelixRequest,
  createAuthAdapterFromEnv,
  sameOriginWrites,
  sessionRoutes,
  type HelixAuthAdapter,
} from "./auth.js";
import { createSteeringNotifier, parseSteeringActionRequest, type SteeringActionReceipt, type SteeringNotification } from "../steering.js";

export interface CreateAppOptions {
  ctx: RunContext;
  pr?: PullRequestCreator;
  githubRepo?: string;
  manage?: ManageService;
  prControl?: PullRequestControlService;
  /** Inject inception specialist sessions (tests). */
  createBootstrapSpecialistFactory?: CreateBootstrapSpecialistFactory;
  /** Inject a standalone or external auth provider without coupling the engine to it. */
  authAdapter?: HelixAuthAdapter;
}

interface ActiveRunEntry {
  eventStream: import("../engine/eventStream.js").EventStream;
  control: import("../engine/runControl.js").RunExecutionControl;
  sseClients: Set<Response>;
  /** Latest accumulated live text per active invocation for late SSE attachment. */
  liveSnapshots: Map<string, RunEvent>;
  promise?: Promise<Run>;
}

export interface GracefulPauseResult {
  requested: number;
  remaining: number;
}

interface ActiveManageEntry {
  sseClients: Set<Response>;
}

export function createApp(opts: CreateAppOptions): Express {
  const { ctx, pr, githubRepo } = opts;
  const createBootstrapSpecialistFactory = opts.createBootstrapSpecialistFactory;
  const manage = opts.manage ?? new ManageService({
    helixDir: ctx.helixDir,
    config: ctx.config,
    model: ctx.model,
    provider: ctx.provider,
  });

  const app = express();
  app.use(express.json());
  app.use(sameOriginWrites());
  app.use(webAssets());

  const authAdapter = opts.authAdapter ?? createAuthAdapterFromEnv();
  const notifySteering = createSteeringNotifier();
  sessionRoutes(app, authAdapter);
  app.get("/health", (_req, res) => {
    res.json({ ok: true, authProvider: authAdapter.provider });
  });
  app.get(["/", "/manage", "/config", "/reviews", "/bootstrap"], webIndex());
  app.use(authenticateRequests(authAdapter), authorizeHelixRequest);

  const activeRuns = new Map<string, ActiveRunEntry>();
  const activeManage = new Map<string, ActiveManageEntry>();
  reconcileInterruptedRuns(ctx.store);

  const launchRun = (
    issue: Issue,
    lineage: { parentRunId?: string; rootRunId?: string; continuation?: RunContinuation } = {},
    resumeRun?: Run,
  ): string => {
    const runId = resumeRun?.id ?? randomUUID();
    const eventStream = new EventStream();
    const control = new RunExecutionControl();
    const entry: ActiveRunEntry = {
      eventStream,
      control,
      sseClients: new Set(),
      liveSnapshots: new Map(),
    };
    activeRuns.set(runId, entry);

    const unsubscribe = eventStream.subscribe((event) => {
      updateLiveSnapshot(entry, event);
      broadcastRunSse(entry, event);
      if (isTerminalRunEvent(event)) closeRunSseClients(entry);
    });

    const active = startRun(ctx, issue, {
      skipDeliverable: false,
      runId,
      eventStream,
      control,
      onEvent: (run, event) => {
        const notification = runNotification(run, event);
        if (notification) notifySteering(notification);
      },
      resumeRun,
      ...lineage,
    });
    entry.promise = active.promise;

    active.promise
      .finally(() => {
        unsubscribe();
        activeRuns.delete(runId);
      })
      .catch(() => {
        /* persisted via onEvent */
      });
    return runId;
  };

  app.locals.pauseActiveRuns = async (
    reason = "Paused for Helix shutdown",
    timeoutMs = 10_000,
  ): Promise<GracefulPauseResult> => {
    const snapshot = [...activeRuns.entries()];
    for (const [, entry] of snapshot) entry.control.requestPause(reason);
    const promises = snapshot.flatMap(([, entry]) => entry.promise ? [entry.promise] : []);
    if (promises.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolveDelay) => {
          timer = setTimeout(resolveDelay, Math.max(0, timeoutMs));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return {
      requested: snapshot.length,
      remaining: snapshot.filter(([id]) => activeRuns.has(id)).length,
    };
  };

  app.post("/runs", async (req: Request, res: Response) => {
    let issue: Issue;
    try {
      issue = await parseRunBody(req.body, githubRepo ?? ctx.config.triggers?.github?.repo);
      issue = attachExternalRef(issue, req.headers, req.body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const runId = launchRun(issue);

    res.status(202).json({ id: runId, status: "running" });
  });

  app.post("/runs/:id/continuations", (req: Request, res: Response) => {
    const parentId = String(req.params.id);
    const body = req.body as Record<string, unknown>;
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
    const externalEventId = typeof body?.externalEventId === "string" ? body.externalEventId.trim() : "";
    const trigger = typeof body?.trigger === "string" ? body.trigger.trim() : "";
    if (!instruction) {
      res.status(400).json({ error: "instruction is required" });
      return;
    }
    if (!externalEventId || externalEventId.length > 200) {
      res.status(400).json({ error: "externalEventId is required and must be 200 characters or fewer" });
      return;
    }
    if (!trigger || trigger.length > 100) {
      res.status(400).json({ error: "trigger is required and must be 100 characters or fewer" });
      return;
    }

    const existing = findContinuationByEvent(ctx.store, externalEventId, parentId);
    if (existing) {
      res.status(200).json({ id: existing.id, status: existing.status, duplicate: true });
      return;
    }

    const parent = ctx.store.load(parentId);
    if (!parent) {
      res.status(404).json({ error: "Parent run not found" });
      return;
    }
    if (parent.status !== "done" && parent.status !== "escalated") {
      res.status(409).json({ error: `Parent run is ${parent.status}; continuations require a terminal run` });
      return;
    }
    const activeChild = findActiveContinuationChild(ctx.store, parentId);
    if (activeChild) {
      res.status(409).json({ error: `Continuation ${activeChild.id} is already running`, id: activeChild.id });
      return;
    }

    const rootId = parent.rootRunId ?? parent.id;
    const root = ctx.store.load(rootId) ?? parent;
    const pullRequestId = parsePositiveInt(body.pullRequestId);
    const pullRequestHeadBranch =
      typeof body.pullRequestHeadBranch === "string" ? body.pullRequestHeadBranch.trim() : "";
    const continuation: RunContinuation = {
      instruction,
      externalEventId,
      trigger,
      ...(pullRequestId !== undefined ? { pullRequestId } : {}),
      ...(pullRequestHeadBranch ? { pullRequestHeadBranch } : {}),
    };
    try {
      const issue = buildContinuationIssue(parent, root, instruction);
      const runId = launchRun(issue, { parentRunId: parent.id, rootRunId: rootId, continuation });
      res.status(202).json({ id: runId, status: "running", parentRunId: parent.id, rootRunId: rootId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/runs", (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit, 50);
    const summaries = ctx.store.listSummaries(limit).map((summary) => ({
      ...summary,
      live: activeRuns.has(summary.id),
    }));
    res.json(summaries);
  });

  app.get("/runs/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const run = ctx.store.load(id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  });

  app.post("/runs/:id/pause", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const entry = activeRuns.get(id);
    if (!entry) {
      const run = ctx.store.load(id);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
      } else {
        res.status(409).json({ error: `Run is ${run.status}; only a live run can be paused` });
      }
      return;
    }
    if (ctx.store.load(id)?.status === "delivering") {
      res.status(409).json({ error: "Deliverable finalization is already running; wait for it to finish or restart Helix if it becomes stuck" });
      return;
    }
    const accepted = entry.control.requestPause("Paused by operator");
    res.status(accepted ? 202 : 200).json({ id, status: "pause_requested", duplicate: !accepted });
  });

  app.post("/runs/:id/resume", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (activeRuns.has(id)) {
      res.status(409).json({ error: "Run is already live" });
      return;
    }
    const run = ctx.store.load(id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    if (run.status !== "paused" && run.status !== "interrupted") {
      res.status(409).json({ error: `Run is ${run.status}; only paused or interrupted runs can be resumed` });
      return;
    }
    const uncertain = uncertainRecoveryItems(run);
    const retryUncertain = req.body?.retryUncertain === true;
    if (uncertain.length > 0 && !retryUncertain) {
      res.status(409).json({
        error: "Run stopped during side-effecting work; confirm an explicit retry",
        requiresRetryConfirmation: true,
        uncertain,
      });
      return;
    }
    if (uncertain.length > 0) {
      for (const invocation of run.checkpoint?.invocations ?? []) {
        if (invocation.status === "uncertain") invocation.status = "pending";
      }
      if (run.checkpoint?.delivery?.status === "uncertain") {
        run.checkpoint.delivery.status = "pending";
      }
      run.events.push({
        ts: Date.now(),
        type: "run_retry_confirmed",
        summary: `Operator confirmed retry for ${uncertain.join(", ")}`,
        details: { uncertain },
      });
      run.runFile = ctx.store.save(run);
    }
    launchRun(run.issue, {}, run);
    res.status(202).json({ id, status: "running" });
  });

  app.post("/api/steering/actions", (req: Request, res: Response) => {
    const action = parseSteeringActionRequest(req.body);
    if (!action) {
      res.status(400).json({ error: "Invalid acme.steering.action.v1 payload" });
      return;
    }
    if (action.actionKey !== "helix.recover_run" || action.resource.type !== "run") {
      res.status(400).json(actionReceipt(action.requestId, "rejected", action.resource.expectedRevision, "Unsupported Helix steering action."));
      return;
    }
    const run = ctx.store.load(action.resource.id);
    if (!run) {
      res.status(404).json(actionReceipt(action.requestId, "rejected", action.resource.expectedRevision, "Run not found."));
      return;
    }
    const currentRevision = String(run.events.at(-1)?.ts ?? run.startedAt);
    if (run.events.some((event) => event.details?.steeringRequestId === action.requestId)) {
      res.json(actionReceipt(action.requestId, "already_applied", currentRevision, "This Steering recovery request was already accepted."));
      return;
    }
    if (activeRuns.has(run.id)) {
      res.json(actionReceipt(action.requestId, "already_applied", currentRevision, "The run is already active."));
      return;
    }
    if (currentRevision !== action.resource.expectedRevision) {
      res.status(409).json(actionReceipt(action.requestId, "stale", currentRevision, "The run changed before the action was applied."));
      return;
    }
    if (run.status !== "paused" && run.status !== "interrupted") {
      res.status(409).json(actionReceipt(action.requestId, "rejected", currentRevision, `Run is ${run.status}; only paused or interrupted runs can be recovered.`));
      return;
    }
    const uncertain = uncertainRecoveryItems(run);
    if (uncertain.length > 0) {
      for (const invocation of run.checkpoint?.invocations ?? []) {
        if (invocation.status === "uncertain") invocation.status = "pending";
      }
      if (run.checkpoint?.delivery?.status === "uncertain") run.checkpoint.delivery.status = "pending";
      run.events.push({
        ts: Date.now(), type: "run_retry_confirmed",
        summary: `Steering administrator confirmed retry for ${uncertain.join(", ")}`,
        details: { uncertain, steeringRequestId: action.requestId },
      });
    } else {
      run.events.push({
        ts: Date.now(), type: "run_retry_confirmed",
        summary: "Steering administrator authorized recovery from the durable checkpoint",
        details: { steeringRequestId: action.requestId },
      });
    }
    run.runFile = ctx.store.save(run);
    launchRun(run.issue, {}, run);
    const acceptedRevision = String(run.events.at(-1)?.ts ?? run.startedAt);
    res.status(202).json({
      ...actionReceipt(action.requestId, "accepted", acceptedRevision, "Helix accepted the run recovery request."),
      operationId: run.id,
    });
  });

  app.delete("/runs/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    let sessionsDir: string | undefined;
    try {
      sessionsDir = runSessionRoot(ctx.helixDir, id);
    } catch {
      // Legacy imported ids may not be valid path segments; never derive a path from them.
    }
    if (activeRuns.has(id)) {
      res.status(409).json({ error: "Cannot delete a running run" });
      return;
    }
    const run = ctx.store.load(id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    if (!ctx.store.delete(id)) {
      res.status(500).json({ error: "Failed to delete run" });
      return;
    }
    if (sessionsDir) rmSync(sessionsDir, { recursive: true, force: true });
    res.status(204).end();
  });

  app.get("/runs/:id/events", (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const run = ctx.store.load(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    for (const event of run.events) {
      writeRunSse(res, event);
    }

    const entry = activeRuns.get(runId);
    if (entry && (run.status === "running" || run.status === "pause_requested" || run.status === "delivering")) {
      for (const event of entry.liveSnapshots.values()) writeRunSse(res, event);
      entry.sseClients.add(res);
      req.on("close", () => entry.sseClients.delete(res));
      return;
    }

    res.end();
  });

  app.post("/runs/:id/approve", async (req: Request, res: Response) => {
    if (!pr) {
      res.status(501).json({ error: "PR merge not configured on this server" });
      return;
    }
    const id = String(req.params.id);
    const run = ctx.store.load(id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    try {
      const updated = await approveRun(run, pr, githubRepo ?? ctx.config.triggers?.github?.repo);
      updated.runFile = ctx.store.save(updated);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/runs/:id/reject", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const run = ctx.store.load(id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    try {
      const updated = rejectRun(run);
      updated.runFile = ctx.store.save(updated);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/pr-reviews", (req: Request, res: Response) => {
    if (!opts.prControl) {
      res.status(501).json({ error: "PR control is not configured on this server" });
      return;
    }
    let request: PullRequestReviewRequest;
    try {
      request = parsePullRequestReviewRequest(req.body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const started = opts.prControl.start(request);
    started.promise.catch(() => {
      // The PR-control service persists and reports its own terminal error state.
    });
    res.status(started.duplicate ? 200 : 202).json({
      id: started.review.id,
      status: started.review.status,
      duplicate: started.duplicate,
      headSha: started.review.request.pullRequest.headSha,
    });
  });

  app.get("/pr-reviews", (req: Request, res: Response) => {
    if (!opts.prControl) {
      res.status(501).json({ error: "PR control is not configured on this server" });
      return;
    }
    res.json(opts.prControl.list(parseLimit(req.query.limit, 50)).map((review) => ({
      ...review,
      live: opts.prControl!.isActive(review.id),
    })));
  });

  app.get("/pr-reviews/:id/events", (req: Request, res: Response) => {
    if (!opts.prControl) {
      res.status(501).json({ error: "PR control is not configured on this server" });
      return;
    }
    const id = String(req.params.id);
    const review = opts.prControl.get(id);
    if (!review) {
      res.status(404).json({ error: "PR review not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    for (const event of review.events) writePullRequestReviewSse(res, event);
    if (!opts.prControl.isActive(id)) {
      res.end();
      return;
    }

    const unsubscribe = opts.prControl.subscribe(id, (event) => {
      writePullRequestReviewSse(res, event);
      if (event.type === "review_completed" || event.type === "review_error") {
        unsubscribe();
        res.end();
      }
    });
    req.on("close", unsubscribe);
    if (!opts.prControl.isActive(id)) {
      unsubscribe();
      res.end();
    }
  });

  app.get("/pr-reviews/:id", (req: Request, res: Response) => {
    if (!opts.prControl) {
      res.status(501).json({ error: "PR control is not configured on this server" });
      return;
    }
    const review = opts.prControl.get(String(req.params.id));
    if (!review) {
      res.status(404).json({ error: "PR review not found" });
      return;
    }
    res.json({ ...review, live: opts.prControl.isActive(review.id) });
  });

  app.get("/manage/agents", (_req, res) => {
    res.json(manage.getInventory().agents);
  });

  app.get("/manage/pr-agents", (_req, res) => {
    res.json(manage.getInventory().prAgents);
  });

  app.get("/manage/inception-agents", (_req, res) => {
    res.json(manage.getInventory().inceptionAgents);
  });

  app.get("/manage/skills", (_req, res) => {
    res.json(manage.getInventory().skills);
  });

  app.get("/manage/inception-skills", (_req, res) => {
    res.json(manage.getInventory().inceptionSkills);
  });

  app.get("/manage/workflow", (_req, res) => {
    try {
      res.json(loadManagedWorkflow(ctx.helixDir));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/manage/workflow", (req: Request, res: Response) => {
    try {
      const workflow = saveManagedWorkflow(ctx.helixDir, (req.body as { steps?: unknown })?.steps);
      refreshRunContextResources(ctx);
      res.json(workflow);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/manage/sessions", (req: Request, res: Response) => {
    const body = req.body as { prompt?: string };
    if (!body?.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    const { id, eventStream, promise } = manage.startSession(body.prompt.trim());
    const entry: ActiveManageEntry = { sseClients: new Set() };
    activeManage.set(id, entry);

    const unsubscribe = eventStream.subscribe((event) => {
      broadcastManageSse(entry, event);
      if (event.type === "applied" || event.type === "error") {
        unsubscribe();
        activeManage.delete(id);
      }
    });

    promise.catch(() => {
      /* session state persisted in manage store */
    });

    res.status(202).json({ id, status: "active" });
  });

  app.get("/manage/sessions/:id", (req: Request, res: Response) => {
    const session = manage.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Manage session not found" });
      return;
    }
    res.json(session);
  });

  app.get("/manage/sessions/:id/events", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const session = manage.getSession(id);
    if (!session) {
      res.status(404).json({ error: "Manage session not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    for (const event of session.events) {
      writeManageSse(res, event);
    }

    const live = req.query.live === "1";
    const entry = activeManage.get(id);
    const stream = manage.eventStreamFor(id);
    if (live && entry && stream && session.status === "active") {
      entry.sseClients.add(res);
      req.on("close", () => entry.sseClients.delete(res));
      return;
    }

    res.end();
  });

  app.post("/manage/sessions/:id/messages", async (req: Request, res: Response) => {
    const body = req.body as { content?: string };
    if (!body?.content || typeof body.content !== "string" || !body.content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    try {
      const session = await manage.sendMessage(String(req.params.id), body.content.trim());
      res.json(session);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/manage/sessions/:id/apply", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const force = Boolean((req.body as { force?: boolean })?.force);
    try {
      const session = manage.applySession(id, force);
      activeManage.delete(id);
      res.json(session);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/manage/sessions/:id/discard", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const session = manage.discardSession(id);
      activeManage.delete(id);
      res.json(session);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/config/snapshot", async (_req, res) => {
    refreshRunContextResources(ctx);
    try {
      res.json(await buildConfigSnapshot(ctx));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/workspace", (_req, res) => {
    res.json(getWorkspaceStatus(ctx.cwd));
  });

  app.post("/local-prs/merge", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { pullRequest?: Record<string, unknown> };
    const pr = body.pullRequest;
    if (!pr || typeof pr !== "object") {
      res.status(400).json({ error: "pullRequest is required" });
      return;
    }
    const id = Number(pr.id);
    const title = typeof pr.title === "string" ? pr.title.trim() : "";
    const repositoryPath = typeof pr.repositoryPath === "string" ? pr.repositoryPath.trim() : "";
    const baseBranch = typeof pr.baseBranch === "string" ? pr.baseBranch.trim() : "";
    const headBranch = typeof pr.headBranch === "string" ? pr.headBranch.trim() : "";
    const headSha = typeof pr.headSha === "string" ? pr.headSha.trim() : "";
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "pullRequest.id must be a positive integer" });
      return;
    }
    if (!title || !baseBranch || !headBranch || !headSha) {
      res.status(400).json({ error: "pullRequest title, baseBranch, headBranch, and headSha are required" });
      return;
    }
    try {
      const result = await mergeLocalPullRequest(ctx.cwd, {
        id,
        title,
        repositoryPath: repositoryPath || ctx.cwd,
        baseBranch,
        headBranch,
        headSha,
      });
      res.json(result);
    } catch (err) {
      res.status(422).json({
        error: err instanceof Error ? err.message : String(err),
        repositoryPath: resolve(ctx.cwd),
      });
    }
  });

  app.get("/bootstrap/export-catalog/status", async (req: Request, res: Response) => {
    try {
      const baseUrl = typeof req.query.baseUrl === "string" ? req.query.baseUrl.trim() : "";
      const status = await probeExportCatalogStatus(baseUrl);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/bootstrap/export-catalog", async (req: Request, res: Response) => {
    try {
      const baseUrl = typeof req.query.baseUrl === "string" ? req.query.baseUrl.trim() : "";
      if (!baseUrl) {
        res.status(400).json({ error: "baseUrl query parameter is required" });
        return;
      }
      const statusRaw = typeof req.query.status === "string" ? req.query.status.trim() : "all";
      const status =
        statusRaw === "adopted"
        || statusRaw === "all"
        || statusRaw === "available"
        || statusRaw === "new"
          ? statusRaw
          : "all";
      const items = await listExportCatalog(baseUrl, status);
      res.json(items);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/bootstrap", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        exportPath?: unknown;
        exportUrl?: unknown;
        exportCatalogUrl?: unknown;
        exportId?: unknown;
        dryRun?: unknown;
        execute?: unknown;
        runAgents?: unknown;
        force?: unknown;
        preset?: unknown;
      };
      const runAgents = body.runAgents === true;
      const execute = !runAgents && (body.execute === true || body.dryRun === false);
      const dryRun = !execute && !runAgents;
      const exportPath =
        typeof body.exportPath === "string" && body.exportPath.trim()
          ? body.exportPath.trim()
          : undefined;
      const exportUrl =
        typeof body.exportUrl === "string" && body.exportUrl.trim()
          ? body.exportUrl.trim()
          : undefined;
      const exportCatalogUrl =
        typeof body.exportCatalogUrl === "string" && body.exportCatalogUrl.trim()
          ? body.exportCatalogUrl.trim()
          : undefined;
      const exportIdRaw = body.exportId;
      const exportId =
        typeof exportIdRaw === "number" && Number.isInteger(exportIdRaw) && exportIdRaw > 0
          ? exportIdRaw
          : typeof exportIdRaw === "string" && /^\d+$/.test(exportIdRaw.trim())
            ? Number(exportIdRaw.trim())
            : undefined;

      const sourceCount = [
        Boolean(exportPath),
        Boolean(exportUrl),
        Boolean(exportCatalogUrl && exportId !== undefined),
      ].filter(Boolean).length;

      if (!runAgents) {
        if (sourceCount === 0) {
          res.status(400).json({
            error: "exportPath, exportUrl, or exportCatalogUrl+exportId is required",
          });
          return;
        }
        if (sourceCount > 1) {
          res.status(400).json({
            error: "Provide only one of exportPath, exportUrl, or exportCatalogUrl+exportId",
          });
          return;
        }
      }

      const status = getWorkspaceStatus(ctx.cwd);
      if (runAgents) {
        if (!status.bootstrap.canRunAgents && status.bootstrap.state !== "running") {
          res.status(409).json({ error: status.bootstrap.reason ?? "Bootstrap agents unavailable" });
          return;
        }
      } else if (!status.bootstrap.available) {
        res.status(409).json({ error: status.bootstrap.reason ?? "Bootstrap unavailable" });
        return;
      }

      const result = await runBootstrap({
        exportPath,
        exportUrl,
        exportCatalogUrl,
        exportId,
        targetDir: ctx.cwd,
        cwd: ctx.cwd,
        helixDir: ctx.helixDir,
        execute,
        runAgents,
        dryRun,
        force: body.force === true,
        preset: typeof body.preset === "string" ? body.preset : undefined,
        provider: ctx.provider,
        createSpecialistFactory: createBootstrapSpecialistFactory,
        detachAgents: execute || runAgents,
      });

      if (dryRun) {
        res.status(200).json(result as BootstrapPreview);
        return;
      }
      const accepted = result as BootstrapExecuteResult | BootstrapAcceptedResult;
      res.status(202).json(accepted);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

const omittedSteeringEventTypes = new Set<RunEvent["type"]>([
  "orchestrator_output_delta",
  "specialist_activity",
  "specialist_output_delta",
]);

function runNotification(run: Run, event: RunEvent): SteeringNotification | undefined {
  if (omittedSteeringEventTypes.has(event.type)) return undefined;
  const open = ["run_paused", "run_interrupted"].includes(event.type);
  const settled = ["run_resumed", "run_retry_confirmed", "run_done"].includes(event.type);
  const state = open ? "open" : settled ? "resolved" : undefined;
  return {
    schemaVersion: "acme.steering.notification.v1",
    id: `helix:run:${run.id}:${event.type}:${event.ts}`,
    source: { product: "helix", resourceType: "run", resourceId: run.id, revision: String(event.ts) },
    event: { type: event.type, occurredAt: new Date(event.ts).toISOString(), summary: event.summary, detail: run.issue.title },
    ...(state ? { steering: {
      caseKey: `run:${run.id}:intervention`, state,
      kind: "intervention",
      title: `Steer Helix run: ${run.issue.title}`,
      action: "helix.recover_run",
      reason: event.summary,
      proposedAction: "Resume from the last durable checkpoint, explicitly retrying uncertain work when present.",
      recommendation: "Use the run evidence and current source state before deciding.",
      reversible: false,
      facts: { runStatus: run.status, eventType: event.type, evidenceComplete: event.type !== "run_error" },
    } } : {}),
  };
}

function actionReceipt(
  requestId: string,
  status: SteeringActionReceipt["status"],
  sourceRevision: string,
  summary: string,
): SteeringActionReceipt {
  return { schemaVersion: "acme.steering.action-receipt.v1", requestId, status, sourceRevision, summary };
}

async function parseRunBody(body: unknown, defaultRepo?: string): Promise<Issue> {
  if (!body || typeof body !== "object") throw new Error("Request body must be a JSON object");
  const b = body as Record<string, unknown>;

  if (typeof b.title === "string") {
    return inlineIssue({
      title: b.title,
      body: typeof b.body === "string" ? b.body : "",
      labels: Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === "string") : [],
      external: parseIssueExternal(b.external),
    });
  }

  if (typeof b.issueNumber === "number" || typeof b.issue === "number") {
    const n = typeof b.issueNumber === "number" ? b.issueNumber : (b.issue as number);
    const repo = typeof b.repo === "string" ? b.repo : defaultRepo;
    if (!repo) throw new Error("repo is required for GitHub issues (config or body.repo)");
    const trigger = new GitHubTrigger(repo);
    return trigger.fetchIssue(n);
  }

  if (b.issue && typeof b.issue === "object") {
    return b.issue as Issue;
  }

  throw new Error('Provide { title, body? } for inline runs or { issueNumber, repo? } for GitHub');
}

function attachExternalRef(
  issue: Issue,
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): Issue {
  const fromHeaders = externalFromHeaders(headers);
  if (fromHeaders) return { ...issue, external: fromHeaders };

  if (body && typeof body === "object" && issue.external) return issue;
  if (issue.external) return issue;

  return issue;
}

function parsePullRequestReviewRequest(value: unknown): PullRequestReviewRequest {
  if (!value || typeof value !== "object") throw new Error("Request body must be a JSON object");
  const body = value as Record<string, unknown>;
  const rawPr = body.pullRequest;
  const rawCallback = body.callback;
  if (!rawPr || typeof rawPr !== "object") throw new Error("pullRequest is required");
  if (!rawCallback || typeof rawCallback !== "object") throw new Error("callback is required");
  const pr = rawPr as Record<string, unknown>;
  const callback = rawCallback as Record<string, unknown>;
  const requiredPrStrings = [
    "title",
    "repositoryPath",
    "baseBranch",
    "baseSha",
    "headBranch",
    "headSha",
    "author",
  ] as const;
  for (const field of requiredPrStrings) {
    if (typeof pr[field] !== "string" || !pr[field].trim()) {
      throw new Error(`pullRequest.${field} is required`);
    }
  }
  const pullRequestId = Number(pr.id);
  if (!Number.isInteger(pullRequestId) || pullRequestId <= 0) {
    throw new Error("pullRequest.id must be a positive integer");
  }
  if (pr.origin !== "helix" && pr.origin !== "external") {
    throw new Error("pullRequest.origin must be helix or external");
  }
  const callbackPullRequestId = Number(callback.pullRequestId);
  if (!Number.isInteger(callbackPullRequestId) || callbackPullRequestId <= 0) {
    throw new Error("callback.pullRequestId must be a positive integer");
  }
  const trackerUrl =
    typeof callback.trackerUrl === "string" ? callback.trackerUrl.trim() : "";
  if (!trackerUrl) throw new Error("callback.trackerUrl is required");
  const externalEventId =
    typeof body.externalEventId === "string" ? body.externalEventId.trim() : "";
  if (!externalEventId || externalEventId.length > 300) {
    throw new Error("externalEventId is required and must be 300 characters or fewer");
  }

  let issue: PullRequestReviewRequest["pullRequest"]["issue"];
  if (pr.issue && typeof pr.issue === "object") {
    const rawIssue = pr.issue as Record<string, unknown>;
    const issueId = Number(rawIssue.id);
    if (
      Number.isInteger(issueId) &&
      issueId > 0 &&
      typeof rawIssue.title === "string" &&
      typeof rawIssue.body === "string"
    ) {
      issue = { id: issueId, title: rawIssue.title, body: rawIssue.body };
    }
  }

  return {
    pullRequest: {
      id: pullRequestId,
      title: String(pr.title).trim(),
      description: typeof pr.description === "string" ? pr.description : "",
      repositoryPath: String(pr.repositoryPath).trim(),
      baseBranch: String(pr.baseBranch).trim(),
      baseSha: String(pr.baseSha).trim(),
      headBranch: String(pr.headBranch).trim(),
      headSha: String(pr.headSha).trim(),
      author: String(pr.author).trim(),
      origin: pr.origin,
      issue,
    },
    callback: {
      trackerUrl,
      pullRequestId: callbackPullRequestId,
    },
    externalEventId,
  };
}

function parseLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

function parsePositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function findContinuationByEvent(
  store: RunStore,
  externalEventId: string,
  parentRunId: string,
): Run | undefined {
  for (const summary of store.listSummaries()) {
    const run = store.load(summary.id);
    if (run?.parentRunId === parentRunId && run.continuation?.externalEventId === externalEventId) {
      return run;
    }
  }
  return undefined;
}

function findActiveContinuationChild(store: RunStore, parentRunId: string): Run | undefined {
  for (const summary of store.listSummaries()) {
    if (
      summary.status !== "running"
      && summary.status !== "pause_requested"
      && summary.status !== "paused"
      && summary.status !== "interrupted"
      && summary.status !== "delivering"
    ) continue;
    const run = store.load(summary.id);
    if (run?.parentRunId === parentRunId) return run;
  }
  return undefined;
}

function writeRunSse(res: Response, event: RunEvent): void {
  if (event.type === "orchestrator_output_delta" || event.type === "specialist_output_delta") {
    // Named live events are ignored by older clients instead of falling
    // through their generic durable-event renderer once per token.
    res.write("event: live\n");
  }
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writePullRequestReviewSse(res: Response, event: PullRequestReviewEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastRunSse(entry: ActiveRunEntry, event: RunEvent): void {
  for (const client of entry.sseClients) {
    writeRunSse(client, event);
  }
}

function updateLiveSnapshot(entry: ActiveRunEntry, event: RunEvent): void {
  const invocationId = event.details?.invocationId;
  if (typeof invocationId !== "string") return;
  const isDelta = event.type === "orchestrator_output_delta" || event.type === "specialist_output_delta";
  const key = `${event.type.startsWith("orchestrator") ? "orchestrator" : "specialist"}:${invocationId}`;
  if (isDelta) {
    const previous = entry.liveSnapshots.get(key);
    const previousDelta = typeof previous?.details?.delta === "string" ? previous.details.delta : "";
    const delta = typeof event.details?.delta === "string" ? event.details.delta : "";
    entry.liveSnapshots.set(key, {
      ...event,
      details: { ...event.details, delta: previousDelta + delta },
    });
    return;
  }
  if (event.type === "orchestrator_finished" || event.type === "specialist_finished") {
    entry.liveSnapshots.delete(key);
  }
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return event.type === "run_done" || event.type === "run_escalated" || event.type === "run_error" || event.type === "run_paused";
}

function reconcileInterruptedRuns(store: RunStore): void {
  for (const summary of store.listSummaries()) {
    if (summary.status !== "running" && summary.status !== "pause_requested" && summary.status !== "delivering") continue;
    const run = store.load(summary.id);
    if (!run) continue;
    for (const invocation of run.checkpoint?.invocations ?? []) {
      if (invocation.status === "started") invocation.status = "uncertain";
    }
    if (run.checkpoint?.delivery?.status === "started") {
      run.checkpoint.delivery.status = "uncertain";
    }
    run.status = "interrupted";
    run.finishedAt = undefined;
    run.events.push({
      ts: Date.now(),
      type: "run_interrupted",
      summary: "Helix restarted without a live executor; resume continues from the last durable checkpoint",
      details: { checkpoint: run.checkpoint },
    });
    run.runFile = store.save(run);
  }
}

function uncertainRecoveryItems(run: Run): string[] {
  const items = (run.checkpoint?.invocations ?? [])
    .filter((invocation) => invocation.status === "uncertain")
    .map((invocation) => `specialist ${invocation.specialist}`);
  if (run.checkpoint?.delivery?.status === "uncertain") items.push("deliverable finalization");
  return items;
}

function closeRunSseClients(entry: ActiveRunEntry): void {
  for (const client of entry.sseClients) client.end();
  entry.sseClients.clear();
}

function writeManageSse(res: Response, event: ManageEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastManageSse(entry: ActiveManageEntry, event: ManageEvent): void {
  for (const client of entry.sseClients) {
    writeManageSse(client, event);
  }
}

export interface StartServerOptions extends CreateAppOptions {
  port?: number;
  host?: string;
}

export type HelixServer = ReturnType<Express["listen"]> & {
  pauseActiveRuns(reason?: string, timeoutMs?: number): Promise<GracefulPauseResult>;
};

export function startServer(opts: StartServerOptions): HelixServer {
  const app = createApp(opts);
  const port = opts.port ?? Number(process.env.PORT ?? HELIX_DEFAULT_PORT);
  const host = opts.host ?? "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`Helix  http://${host}:${port}${webFromSource() ? "  (web from source)" : ""}`);
  }) as HelixServer;
  server.pauseActiveRuns = app.locals.pauseActiveRuns as HelixServer["pauseActiveRuns"];
  attachHmr(server);
  return server;
}
