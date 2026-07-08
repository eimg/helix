#!/usr/bin/env node
/**
 * helix run <issue-number>
 *
 * M1 entry point: load .helix/config.json + .helix/agents/*.md, build the
 * engine with the OpenRouter provider + real pi specialist sessions + the LLM
 * orchestrator, fetch the issue via `gh`, run, and persist state.
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
import { FileRunStore } from "./state/runStore.js";
import { DEFAULT_GATE_CONFIG } from "./orchestrator/gates.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "run" || !args[1]) {
    console.error("Usage: helix run <issue-number>");
    process.exit(2);
  }

  const issueNumber = Number(args[1]);
  if (!Number.isInteger(issueNumber)) {
    console.error(`Invalid issue number: ${args[1]}`);
    process.exit(2);
  }

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
  const orchestrator = new LlmOrchestrator(provider, workflow, config.orchestrator.model);

  // Event stream + console logger
  const eventStream = new EventStream();
  attachConsoleLogger(eventStream);

  const factory = new PiSpecialistSessionFactory(provider, specialists);

  const deps: EngineDeps = {
    provider,
    orchestrator,
    specialistFactory: factory,
    gates: { ...DEFAULT_GATE_CONFIG, maxIterations: workflow.maxIterations },
    eventStream,
  };

  // Trigger
  const repo = config.triggers?.github?.repo;
  if (!repo) {
    console.error("config: triggers.github.repo is required for `helix run`.");
    process.exit(1);
  }
  const trigger = new GitHubTrigger(repo);

  let issue;
  try {
    issue = await trigger.fetchIssue(issueNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch issue #${issueNumber} from ${repo}: ${msg}`);
    console.error("(Is the `gh` CLI installed and authenticated?)");
    process.exit(1);
  }

  const run = await runIssue(issue, deps);
  orchestrator.dispose();

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
