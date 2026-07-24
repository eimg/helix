#!/usr/bin/env node
/**
 * helix init [--preset <name>] [--force] [--list]
 * helix run <issue-number> | --title "..." [--body "..."] | --stdin
 * helix bootstrap --export <path> [--target <dir>] [--dry-run|--execute|--run-agents]
 * helix serve [--port 8319]   # M2: HTTP API + web UI + optional GitHub poll
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, githubPrEnabled, localPrEnabled } from "./config.js";
import { resolveModelRef } from "./config/env.js";
import { runIssue, type EngineDeps } from "./engine/engine.js";
import { EventStream } from "./engine/eventStream.js";
import { attachConsoleLogger } from "./engine/consoleLogger.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { loadSpecialists, findHelixDir } from "./agents/loader.js";
import { PiSpecialistSessionFactory } from "./agents/session.js";
import { loadWorkflow } from "./orchestrator/workflow.js";
import { LlmOrchestrator } from "./orchestrator/driver.js";
import { GitHubTrigger } from "./triggers/github.js";
import { inlineIssue } from "./triggers/inline.js";
import { SqliteRunStore } from "./state/runStore.js";
import { DEFAULT_GATE_CONFIG } from "./orchestrator/gates.js";
import { init } from "./init.js";
import type { Issue, Run } from "./engine/types.js";
import { createRunContext } from "./run/bootstrap.js";
import { startServer } from "./server/app.js";
import { DefaultDeliverablePipeline, NoOpDeliverablePipeline } from "./deliverable/pipeline.js";
import { ShellGitContext } from "./deliverable/git.js";
import { GhPullRequestCreator } from "./deliverable/pr.js";
import { GitHubPollTrigger } from "./triggers/github-poll.js";
import { startRun } from "./run/bootstrap.js";
import { HELIX_DEFAULT_PORT } from "./config/defaults.js";
import { PullRequestControlService } from "./pr-control/service.js";
import { SqlitePullRequestReviewStore } from "./pr-control/store.js";
import { GitPullRequestWorkspace } from "./pr-control/workspace.js";
import { LocalPullRequestDeliverablePipeline } from "./deliverable/localPullRequest.js";
import { GitRunWorkspaceManager } from "./run/workspace.js";
import { loadPullRequestSpecialists } from "./pr-control/loader.js";
import { parseBootstrapArgs, runBootstrapCommand } from "./inception/command.js";
import { ensureInceptionScaffold } from "./inception/workspace.js";

function usage(): never {
  console.error(`Usage:
  helix init [--preset <name>] [--force] [--list]
  helix run <issue-number>                    # fetch from GitHub
  helix run --title "..." [--body "..."]      # inline issue
  helix run --stdin [--title "..."]           # body from stdin
  helix bootstrap --export <path> [--target <dir>] [--dry-run|--execute|--run-agents]
                                              # empty-workspace inception; execute creates git + .helix in place
  helix serve [--port <n>]                    # HTTP API + web UI (default 8319; scaffolds empty dirs)`);
  process.exit(2);
}

interface ParsedArgs {
  mode: "github" | "inline";
  issueNumber?: number;
  title?: string;
  body?: string;
  readStdin: boolean;
}

function parseRunArgs(args: string[]): ParsedArgs {
  let title: string | undefined;
  let body: string | undefined;
  let readStdin = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--title") title = args[++i];
    else if (a === "--body") body = args[++i];
    else if (a === "--stdin") readStdin = true;
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }

  if (title !== undefined || readStdin) {
    return { mode: "inline", title, body, readStdin };
  }
  if (positional.length === 1) {
    const n = Number(positional[0]);
    if (!Number.isInteger(n)) {
      console.error(`Invalid issue number: ${positional[0]}`);
      process.exit(2);
    }
    return { mode: "github", issueNumber: n, readStdin: false };
  }
  usage();
}

function parseServeArgs(args: string[]): { port: number } {
  let port = Number(process.env.PORT ?? HELIX_DEFAULT_PORT);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = Number(args[++i]);
    else usage();
  }
  if (!Number.isInteger(port) || port <= 0) {
    console.error("Invalid port");
    process.exit(2);
  }
  return { port };
}

async function readStdinBody(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function buildIssue(parsed: ParsedArgs, repo: string): Promise<Issue> {
  if (parsed.mode === "inline") {
    let title = parsed.title;
    let body = parsed.body;
    if (parsed.readStdin) {
      const stdin = await readStdinBody();
      if (title === undefined) {
        const nl = stdin.indexOf("\n");
        title = nl === -1 ? stdin : stdin.slice(0, nl).trim();
        body = nl === -1 ? "" : stdin.slice(nl + 1).trim();
      } else {
        body = stdin;
      }
    }
    if (!title) {
      console.error("Inline issue needs a title (--title or first stdin line).");
      process.exit(2);
    }
    return inlineIssue({ title, body });
  }

  const trigger = new GitHubTrigger(repo);
  try {
    return await trigger.fetchIssue(parsed.issueNumber!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch issue #${parsed.issueNumber} from ${repo}: ${msg}`);
    console.error("(Is the `gh` CLI installed and authenticated?)");
    process.exit(1);
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  const helixDir = findHelixDir();
  let config;
  try {
    config = loadConfig(helixDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Could not load ${resolve(helixDir, "config.json")}: ${msg}`);
    process.exit(1);
  }

  const provider = new OpenRouterProvider();
  if (!provider.hasAuth()) {
    console.error(
      `No OpenRouter API key found. Set OPENROUTER_API_KEY in .helix/.env, or configure openrouter in ~/.pi/agent/auth.json.`
    );
    process.exit(1);
  }

  const specialists = loadSpecialists(resolve(helixDir, "agents"));
  if (specialists.length === 0) {
    console.error(`No specialists found in ${resolve(helixDir, "agents")}.`);
    process.exit(1);
  }

  const workflow = loadWorkflow(config);
  const model = resolveModelRef().value;
  const orchestrator = new LlmOrchestrator(provider, workflow, model, {
    helixDir,
    extensions: config.extensions,
  });

  const eventStream = new EventStream();
  attachConsoleLogger(eventStream);

  const factory = new PiSpecialistSessionFactory(provider, specialists, {
    helixDir,
    defaultModel: model,
    extensions: config.extensions,
  });

  const deps: EngineDeps = {
    provider,
    orchestrator,
    specialistFactory: factory,
    gates: { ...DEFAULT_GATE_CONFIG, maxIterations: workflow.maxIterations },
    eventStream,
  };

  const repo = config.triggers?.github?.repo;
  if (parsed.mode === "github" && !repo) {
    console.error("config: triggers.github.repo is required for GitHub issue fetch.");
    process.exit(1);
  }

  const issue = await buildIssue(parsed, repo ?? "(inline)");

  let run;
  try {
    run = await runIssue(issue, deps);
  } finally {
    orchestrator.dispose();
  }

  const store = new SqliteRunStore(resolve(helixDir, "runs.db"), resolve(helixDir, "runs"));
  run.runFile = store.save(run);
  printSummary(run);
}

async function cmdServe(args: string[]): Promise<void> {
  const { port } = parseServeArgs(args);
  const cwd = process.cwd();
  let helixDir = findHelixDir(cwd);

  // Empty-workspace inception entry: scaffold .helix from presets (no git yet).
  if (!existsSync(resolve(helixDir, "config.json"))) {
    try {
      const scaffold = ensureInceptionScaffold(cwd);
      helixDir = scaffold.helixDir;
      if (scaffold.created) {
        console.log(`Inception: scaffolded ${helixDir} in empty workspace (git is created by helix bootstrap --execute).`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  const config = loadConfig(helixDir);
  const repo = config.triggers?.github?.repo;
  const prEnabled = githubPrEnabled(config);
  const localPullRequestEnabled = localPrEnabled(config);
  const gitReady = existsSync(resolve(cwd, ".git"));

  if (prEnabled && !repo) {
    console.error('config: deliverable.pr is true but triggers.github.repo is missing.');
    process.exit(1);
  }

  const pr = prEnabled ? new GhPullRequestCreator({ cwd, repo }) : undefined;
  const deliverable = prEnabled && pr
    ? new DefaultDeliverablePipeline({
        git: new ShellGitContext({ cwd }),
        pr,
        repo,
      })
    : localPullRequestEnabled && gitReady
      ? new LocalPullRequestDeliverablePipeline({
          cwd,
          baseBranch: config.deliverable?.baseBranch,
        })
    : new NoOpDeliverablePipeline();

  const ctx = createRunContext({
    helixDir,
    cwd,
    deliverable,
    workspace: localPullRequestEnabled && gitReady
      ? new GitRunWorkspaceManager(cwd, config.deliverable?.baseBranch)
      : undefined,
  });
  const prControlSpecialists = loadPullRequestSpecialists(helixDir);
  const prControl = new PullRequestControlService({
    store: new SqlitePullRequestReviewStore(resolve(helixDir, "pr-reviews.db")),
    workspace: new GitPullRequestWorkspace(ctx.cwd),
    specialists: prControlSpecialists,
    createSessionFactory: (sessionCwd) =>
      new PiSpecialistSessionFactory(ctx.provider, prControlSpecialists, {
        cwd: sessionCwd,
        helixDir: ctx.helixDir,
        defaultModel: ctx.model,
        extensions: ctx.config.extensions,
      }),
  });

  if (!ctx.provider.hasAuth()) {
    console.error(
      `No OpenRouter API key found. Set OPENROUTER_API_KEY in .helix/.env, or configure openrouter in ~/.pi/agent/auth.json.`
    );
    process.exit(1);
  }

  if (ctx.specialists.length === 0) {
    console.error(`No specialists found in ${resolve(helixDir, "agents")}.`);
    process.exit(1);
  }

  startServer({ ctx, pr, githubRepo: repo, prControl, port, host: "127.0.0.1" });
  if (!gitReady) {
    console.log("Inception mode: workspace has no git yet. Run helix bootstrap --export … --execute to create the project repo.");
  }
  if (!prEnabled) {
    console.log(
      localPullRequestEnabled && gitReady
        ? "Deliverable: Acme-linked runs register a local PR; merge remains human-only."
        : localPullRequestEnabled
          ? "Deliverable: local PR registration waits until git exists (after bootstrap --execute)."
          : "Deliverable: PR creation disabled.",
    );
  }

  const gh = config.triggers?.github;
  if (gh?.mode === "poll" && repo) {
    const poll = new GitHubPollTrigger({
      repo,
      labelFilter: gh.labelFilter,
      intervalSec: gh.intervalSec,
      onIssue: (issue) => {
        console.log(`Poll: starting run for issue #${issue.number}: ${issue.title}`);
        const { promise } = startRun(ctx, issue);
        promise.catch((err) => {
          console.error(`Run failed for issue #${issue.number}:`, err instanceof Error ? err.message : err);
        });
      },
    });
    poll.start();
    console.log(`GitHub poll enabled (${repo}, label=${gh.labelFilter ?? "any"}, every ${gh.intervalSec ?? 60}s)`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  if (args[0] === "init") {
    const opts: { preset?: string; force?: boolean; list?: boolean } = {};
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--preset") opts.preset = args[++i];
      else if (a === "--force") opts.force = true;
      else if (a === "--list") opts.list = true;
      else {
        console.error(`Unknown option: ${a}`);
        process.exit(2);
      }
    }
    try {
      init(opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (args[0] === "serve") {
    await cmdServe(args.slice(1));
    return;
  }

  if (args[0] === "bootstrap") {
    try {
      await runBootstrapCommand(parseBootstrapArgs(args.slice(1)));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  const rest = args[0] === "run" ? args.slice(1) : args;
  if (rest.length === 0) usage();
  await cmdRun(rest);
}

function printSummary(run: Run): void {
  const isTTY = process.stdout.isTTY ?? false;
  const p = (code: string, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => p("2", s);
  const green = (s: string) => p("32", s);
  const yellow = (s: string) => p("33", s);
  const red = (s: string) => p("31", s);

  const results = run.results;
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const elapsed =
    run.finishedAt != null
      ? `${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))}s`
      : "?";

  const stats = `${results.length} specialist${results.length === 1 ? "" : "s"} · ${elapsed}` +
    (fail > 0 ? ` (${ok} ok, ${fail} failed)` : "");

  console.log("");
  console.log(dim("─".repeat(60)));

  if (run.status === "done") {
    console.log(`${green("✓ done")}  ${dim(stats)}`);
    if (run.pullRequest) console.log(`  ${dim("PR:")} ${run.pullRequest.url}`);
    if (run.approvalStatus === "pending") console.log(`  ${yellow("awaiting approval")}`);
  } else if (run.status === "escalated") {
    console.log(`${yellow("▲ escalated")}  ${dim(stats)}`);
  } else if (run.status === "error") {
    console.log(`${red("✗ error")}  ${dim(stats)}`);
  } else {
    console.log(`? ended (${run.status})  ${dim(stats)}`);
  }

  if (run.runFile) console.log(`  ${dim("run file:")} ${run.runFile}`);
  console.log("");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
