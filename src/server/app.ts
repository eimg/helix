/**
 * Express host — consumer of the engine API (M2).
 *
 * POST /runs          start a run (inline or GitHub issue number)
 * POST /runs/:id/continuations   start an externally triggered linked child run
 * GET  /runs          list run summaries (newest first)
 * GET  /runs/:id      run state snapshot
 * DELETE /runs/:id    delete a finished run (testing cleanup)
 * GET  /runs/:id/events   SSE stream of RunEvents
 * POST /runs/:id/approve | /reject   human merge gate decisions
 * POST /pr-reviews     start an independent, SHA-bound local PR review
 * GET  /pr-reviews     list PR-control reviews
 * GET  /pr-reviews/:id inspect one PR-control review
 * GET  /pr-reviews/:id/events stream durable PR-review lifecycle events
 *
 * Manage (experimental):
 * POST /manage/sessions, GET /manage/sessions/:id, SSE events, apply, discard
 * GET  /manage/agents | /manage/skills | /manage/workflow
 * PUT  /manage/workflow   update the ordered default workflow
 *
 * Config (observability):
 * GET  /config            Config tab UI
 * GET  /config/snapshot   resolved runtime config + provenance
 */
import express, { type Express, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunContext } from "../run/bootstrap.js";
import { refreshRunContextResources, startRun } from "../run/bootstrap.js";
import type { Issue, Run, RunContinuation, RunEvent } from "../engine/types.js";
import { EventStream } from "../engine/eventStream.js";
import { inlineIssue } from "../triggers/inline.js";
import { GitHubTrigger } from "../triggers/github.js";
import { approveRun, rejectRun } from "../deliverable/pipeline.js";
import type { PullRequestCreator } from "../deliverable/pr.js";
import { HELIX_DEFAULT_PORT } from "../config/defaults.js";
import { buildConfigSnapshot } from "../config/snapshot.js";
import { ManageService } from "../manage/service.js";
import type { ManageEvent } from "../manage/types.js";
import { externalFromHeaders, parseIssueExternal } from "../callbacks/issueTracker.js";
import { loadManagedWorkflow, saveManagedWorkflow } from "../manage/workflow.js";
import { buildContinuationIssue } from "../run/continuation.js";
import type { RunStore } from "../state/runStore.js";
import type { PullRequestControlService } from "../pr-control/service.js";
import type { PullRequestReviewEvent, PullRequestReviewRequest } from "../pr-control/types.js";

export interface CreateAppOptions {
  ctx: RunContext;
  pr?: PullRequestCreator;
  githubRepo?: string;
  manage?: ManageService;
  prControl?: PullRequestControlService;
}

interface ActiveRunEntry {
  eventStream: import("../engine/eventStream.js").EventStream;
  sseClients: Set<Response>;
  /** Latest accumulated live text per active invocation for late SSE attachment. */
  liveSnapshots: Map<string, RunEvent>;
}

interface ActiveManageEntry {
  sseClients: Set<Response>;
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const bundledReactDir = join(dirname(fileURLToPath(import.meta.url)), "react");
const reactDir = existsSync(bundledReactDir)
  ? bundledReactDir
  : resolve(process.cwd(), "dist/server/react");

export function createApp(opts: CreateAppOptions): Express {
  const { ctx, pr, githubRepo } = opts;
  const manage = opts.manage ?? new ManageService({
    helixDir: ctx.helixDir,
    config: ctx.config,
    model: ctx.model,
    provider: ctx.provider,
  });

  const app = express();
  app.use(express.json());

  const activeRuns = new Map<string, ActiveRunEntry>();
  const activeManage = new Map<string, ActiveManageEntry>();

  const launchRun = (
    issue: Issue,
    lineage: { parentRunId?: string; rootRunId?: string; continuation?: RunContinuation } = {},
  ): string => {
    const runId = randomUUID();
    const eventStream = new EventStream();
    const entry: ActiveRunEntry = { eventStream, sseClients: new Set(), liveSnapshots: new Map() };
    activeRuns.set(runId, entry);

    const unsubscribe = eventStream.subscribe((event) => {
      updateLiveSnapshot(entry, event);
      broadcastRunSse(entry, event);
      if (isTerminalRunEvent(event)) closeRunSseClients(entry);
    });

    const { promise } = startRun(ctx, issue, {
      skipDeliverable: false,
      runId,
      eventStream,
      ...lineage,
    });

    promise
      .finally(() => {
        unsubscribe();
        activeRuns.delete(runId);
      })
      .catch(() => {
        /* persisted via onEvent */
      });
    return runId;
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
    const continuation: RunContinuation = { instruction, externalEventId, trigger };
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

  app.delete("/runs/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
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
    if (entry && run.status === "running") {
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

  app.get("/manage/skills", (_req, res) => {
    res.json(manage.getInventory().skills);
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

  app.get("/config/snapshot", (_req, res) => {
    refreshRunContextResources(ctx);
    res.json(buildConfigSnapshot(ctx));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(publicDir, {
    setHeaders(res) {
      // The SSE protocol and its browser client evolve together. Avoid leaving
      // an older app.js active against a newer event stream after restart.
      res.setHeader("Cache-Control", "no-store");
    },
  }));
  app.use("/react", express.static(reactDir));
  app.get("/react", (_req, res) => res.redirect("/react/"));
  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });
  app.get("/manage", (_req, res) => {
    res.sendFile(join(publicDir, "manage.html"));
  });
  app.get("/config", (_req, res) => {
    res.sendFile(join(publicDir, "config.html"));
  });
  app.get("/reviews", (_req, res) => {
    res.sendFile(join(publicDir, "reviews.html"));
  });

  return app;
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
    if (summary.status !== "running") continue;
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
  return event.type === "run_done" || event.type === "run_escalated" || event.type === "run_error";
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

export function startServer(opts: StartServerOptions): ReturnType<Express["listen"]> {
  const app = createApp(opts);
  const port = opts.port ?? Number(process.env.PORT ?? HELIX_DEFAULT_PORT);
  const host = opts.host ?? "127.0.0.1";
  return app.listen(port, host, () => {
    console.log(`Helix  http://${host}:${port}`);
  });
}
