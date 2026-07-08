#!/usr/bin/env node
/**
 * helix run <issue-number>          # fetch from GitHub via `gh`
 * helix run --title "..." [--body "..."]  # inline: no GitHub, no network
 * helix run --stdin [--title "..."]       # read body from stdin
 *
 * The inline paths prove the orchestrator and trigger adapter are independent:
 * `runIssue()` takes a plain `Issue`, and an inline issue is constructed
 * directly without any `Trigger.fetchIssue()` call.
 */
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
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
import { FileRunStore } from "./state/runStore.js";
import { DEFAULT_GATE_CONFIG } from "./orchestrator/gates.js";
import type { Issue } from "./engine/types.js";

function usage(): never {
  console.error(`Usage:
  helix run <issue-number>                    # fetch from GitHub
  helix run --title "..." [--body "..."]      # inline issue
  helix run --stdin [--title "..."]           # body from stdin`);
  process.exit(2);
}

interface ParsedArgs {
  mode: "github" | "inline";
  issueNumber?: number;
  title?: string;
  body?: string;
  readStdin: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
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
        // first line is the title, rest is the body
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

  // GitHub
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "run" && args.length === 1) usage();
  // accept `helix run ...` or `helix ...`
  const rest = args[0] === "run" ? args.slice(1) : args;
  if (rest.length === 0) usage();
  const parsed = parseArgs(rest);

  const helixDir = findHelixDir();
  let config;
  try {
    config = loadConfig(helixDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Could not load ${resolve(helixDir, "config.json")}: ${msg}`);
    console.error("(See examples/ts/.helix/config.json for a reference config, and presets/ for specialists.)");
    process.exit(1);
  }

  // Provider
  const provider = new OpenRouterProvider({
    apiKeyEnv: config.provider.apiKeyEnv ?? "OPENROUTER_API_KEY",
    inheritPi: config.inheritPi,
  });
  if (!provider.hasAuth()) {
    console.error(
      `No OpenRouter API key found. Set ${config.provider.apiKeyEnv ?? "OPENROUTER_API_KEY"} or configure auth.json.`,
    );
    process.exit(1);
  }

  // Specialists
  const specialists = loadSpecialists(resolve(helixDir, "agents"));
  if (specialists.length === 0) {
    console.error(`No specialists found in ${resolve(helixDir, "agents")}. Add .md definitions (see presets/).`);
    process.exit(1);
  }

  // Orchestrator + workflow
  const workflow = loadWorkflow(config);
  const orchestrator = new LlmOrchestrator(provider, workflow, config.orchestrator.model, {
    helixDir,
    inheritPi: config.inheritPi,
    extensions: config.extensions,
  });

  // Event stream + console logger
  const eventStream = new EventStream();
  attachConsoleLogger(eventStream);

  const factory = new PiSpecialistSessionFactory(provider, specialists, {
    helixDir,
    inheritPi: config.inheritPi,
    extensions: config.extensions,
  });

  const deps: EngineDeps = {
    provider,
    orchestrator,
    specialistFactory: factory,
    gates: { ...DEFAULT_GATE_CONFIG, maxIterations: workflow.maxIterations },
    eventStream,
  };

  // Inline mode needs no repo; GitHub mode does.
  const repo = config.triggers?.github?.repo;
  if (parsed.mode === "github" && !repo) {
    console.error("config: triggers.github.repo is required for GitHub issue fetch. Use --title/--stdin for inline.");
    process.exit(1);
  }

  const issue = await buildIssue(parsed, repo ?? "(inline)");

  let run;
  try {
    run = await runIssue(issue, deps);
  } finally {
    orchestrator.dispose();
  }

  // Persist
  const store = new FileRunStore(resolve(helixDir, "runs"));
  run.runFile = store.save(run);

  console.log("");
  switch (run.status) {
    case "done":
      console.log(`✓ Run done — ${run.finalDecision?.reason ?? ""}`);
      if (run.finalDecision?.kind === "done" && run.finalDecision.deliverable) {
        console.log(`  Deliverable: ${run.finalDecision.deliverable}`);
      }
      break;
    case "escalated":
      console.log(`▲ Escalated — ${run.finalDecision?.reason ?? ""}`);
      break;
    case "error":
      console.log(`✗ Run errored.`);
      break;
    default:
      console.log(`? Run ended in status ${run.status}.`);
  }
  console.log(`  Run file: ${run.runFile}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
