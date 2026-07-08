import { test } from "node:test";
import assert from "node:assert/strict";
import { runIssue } from "../src/engine/engine.js";
import type { OrchestratorDecision, SpecialistDefinition, RunEvent } from "../src/engine/types.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";
import { inlineIssue } from "../src/triggers/inline.js";

function def(name: string): SpecialistDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `You are ${name}.`,
    filePath: `/fake/${name}.md`,
    source: "project",
  };
}

test("inline issue: runs end-to-end with no Trigger / no GitHub", async () => {
  // Constructed directly — no fetchIssue, no `gh`, no network. This proves the
  // orchestrator is independent of the trigger adapter.
  const issue = inlineIssue({
    title: "Add rate limiting to the API",
    body: "We need a basic token-bucket limiter on /api routes.",
    labels: ["enhancement"],
  });
  assert.equal(issue.source, "inline");
  assert.equal(issue.number, undefined);
  assert.equal(issue.repo, undefined);

  const factory = new StubSpecialistFactory([def("planner")], {
    planner: "PLAN: add token-bucket middleware",
  });
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "planner", task: "plan it" }], reason: "start" },
    { kind: "done", reason: "plan produced", deliverable: "plan.md" },
  ];
  const events: RunEvent[] = [];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
    onEvent: (_r, e) => events.push(e),
  });

  assert.equal(run.status, "done");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].specialist, "planner");
  assert.equal(run.finalDecision?.kind, "done");
  // the inline issue flowed into the run record
  assert.equal(run.issue.title, "Add rate limiting to the API");
  assert.equal(run.issue.source, "inline");
  assert.ok(events.some((e) => e.type === "run_started" && /inline/.test(e.summary)));
  assert.ok(events.some((e) => e.type === "issue_fetched" && e.details?.source === "inline"));
});
