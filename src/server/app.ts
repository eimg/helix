/**
 * Express host — consumer of the engine API (M2).
 *
 * POST /runs          start a run (inline or GitHub issue number)
 * GET  /runs/:id      run state snapshot
 * GET  /runs/:id/events   SSE stream of RunEvents
 * POST /runs/:id/approve | /reject   human merge gate decisions
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

export interface CreateAppOptions {
  ctx: RunContext;
  pr?: PullRequestCreator;
  githubRepo?: string;
}

interface ActiveEntry {
  eventStream: import("../engine/eventStream.js").EventStream;
  sseClients: Set<Response>;
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

export function createApp(opts: CreateAppOptions): Express {
  const { ctx, pr, githubRepo } = opts;
  const app = express();
  app.use(express.json());

  const active = new Map<string, ActiveEntry>();

  app.post("/runs", async (req: Request, res: Response) => {
    let issue: Issue;
    try {
      issue = await parseRunBody(req.body, githubRepo ?? ctx.config.triggers?.github?.repo);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const { runId, eventStream, promise } = startRun(ctx, issue, { skipDeliverable: false });

    const entry: ActiveEntry = { eventStream, sseClients: new Set() };
    active.set(runId, entry);

    const unsubscribe = eventStream.subscribe((event) => {
      broadcastSse(entry, event);
    });

    promise
      .finally(() => {
        unsubscribe();
        active.delete(runId);
      })
      .catch(() => {
        /* persisted via onEvent */
      });

    res.status(202).json({ id: runId, status: "running" });
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
      writeSse(res, event);
    }

    const entry = active.get(runId);
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

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(publicDir));
  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
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

function writeSse(res: Response, event: RunEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcastSse(entry: ActiveEntry, event: RunEvent): void {
  for (const client of entry.sseClients) {
    writeSse(client, event);
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
    console.log(`Helix server listening on http://${host}:${port}`);
    console.log(`Web UI: http://${host}:${port}/`);
  });
}
