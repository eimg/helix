/**
 * Express host — consumer of the engine API (M2).
 *
 * POST /runs          start a run (inline or GitHub issue number)
 * GET  /runs          list run summaries (newest first)
 * GET  /runs/:id      run state snapshot
 * DELETE /runs/:id    delete a finished run (testing cleanup)
 * GET  /runs/:id/events   SSE stream of RunEvents
 * POST /runs/:id/approve | /reject   human merge gate decisions
 *
 * Manage (experimental):
 * POST /manage/sessions, GET /manage/sessions/:id, SSE events, apply, discard
 * GET  /manage/agents | /manage/skills
 *
 * Config (observability):
 * GET  /config            Config tab UI
 * GET  /config/snapshot   resolved runtime config + provenance
 */
import express, { type Express, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunContext } from "../run/bootstrap.js";
import { startRun } from "../run/bootstrap.js";
import type { Issue, RunEvent } from "../engine/types.js";
import { inlineIssue } from "../triggers/inline.js";
import { GitHubTrigger } from "../triggers/github.js";
import { approveRun, rejectRun } from "../deliverable/pipeline.js";
import type { PullRequestCreator } from "../deliverable/pr.js";
import { HELIX_DEFAULT_PORT } from "../config/defaults.js";
import { buildConfigSnapshot } from "../config/snapshot.js";
import { ManageService } from "../manage/service.js";
import type { ManageEvent } from "../manage/types.js";
import { externalFromHeaders, parseIssueExternal } from "../callbacks/issueTracker.js";

export interface CreateAppOptions {
  ctx: RunContext;
  pr?: PullRequestCreator;
  githubRepo?: string;
  manage?: ManageService;
}

interface ActiveRunEntry {
  eventStream: import("../engine/eventStream.js").EventStream;
  sseClients: Set<Response>;
}

interface ActiveManageEntry {
  sseClients: Set<Response>;
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

export function createApp(opts: CreateAppOptions): Express {
  const { ctx, pr, githubRepo } = opts;
  const manage = opts.manage ?? new ManageService({
    helixDir: ctx.helixDir,
    config: ctx.config,
    provider: ctx.provider,
  });

  const app = express();
  app.use(express.json());

  const activeRuns = new Map<string, ActiveRunEntry>();
  const activeManage = new Map<string, ActiveManageEntry>();

  app.post("/runs", async (req: Request, res: Response) => {
    let issue: Issue;
    try {
      issue = await parseRunBody(req.body, githubRepo ?? ctx.config.triggers?.github?.repo);
      issue = attachExternalRef(issue, req.headers, req.body);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const { runId, eventStream, promise } = startRun(ctx, issue, { skipDeliverable: false });

    const entry: ActiveRunEntry = { eventStream, sseClients: new Set() };
    activeRuns.set(runId, entry);

    const unsubscribe = eventStream.subscribe((event) => {
      broadcastRunSse(entry, event);
    });

    promise
      .finally(() => {
        unsubscribe();
        activeRuns.delete(runId);
      })
      .catch(() => {
        /* persisted via onEvent */
      });

    res.status(202).json({ id: runId, status: "running" });
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

  app.get("/manage/agents", (_req, res) => {
    res.json(manage.getInventory().agents);
  });

  app.get("/manage/skills", (_req, res) => {
    res.json(manage.getInventory().skills);
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
    res.json(buildConfigSnapshot(ctx));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });
  app.get("/manage", (_req, res) => {
    res.sendFile(join(publicDir, "manage.html"));
  });
  app.get("/config", (_req, res) => {
    res.sendFile(join(publicDir, "config.html"));
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

function parseLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

function writeRunSse(res: Response, event: RunEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastRunSse(entry: ActiveRunEntry, event: RunEvent): void {
  for (const client of entry.sseClients) {
    writeRunSse(client, event);
  }
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
