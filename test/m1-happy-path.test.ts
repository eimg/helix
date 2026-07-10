import { test } from "node:test";
import assert from "node:assert/strict";
import { runIssue } from "../src/engine/engine.js";
import type { Issue, OrchestratorDecision, SpecialistDefinition, SpecialistSessionFactory, RunEvent } from "../src/engine/types.js";
import { FakeProvider } from "../src/providers/fake.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { ScriptedOrchestrator } from "../src/orchestrator/scripted.js";

const issue: Issue = {
  source: "github",
  repo: "acme/widget",
  number: 42,
  title: "Fix login bug",
  body: "Login returns 500 on empty password.",
  url: "https://github.com/acme/widget/issues/42",
  labels: ["helix"],
};

function def(name: string): SpecialistDefinition {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `You are ${name}.`,
    filePath: `/fake/${name}.md`,
    source: "project",
  };
}

test("happy path: planner then dev -> done", async () => {
  const defs = [def("planner"), def("dev")];
  const factory = new StubSpecialistFactory(defs, {
    planner: "PLAN: step 1, step 2",
    dev: "IMPLEMENTED the fix in src/login.ts",
  });
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "planner", task: "plan #42" }], reason: "start with a plan" },
    { kind: "run", specialists: [{ specialist: "dev", task: "implement the plan" }], reason: "execute plan" },
    { kind: "done", reason: "all steps complete", deliverable: "src/login.ts fix" },
  ];
  const events: RunEvent[] = [];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
    onEvent: (_run, e) => events.push(e),
  });

  assert.equal(run.status, "done");
  assert.equal(run.results.length, 2);
  assert.equal(run.results[0].specialist, "planner");
  assert.equal(run.results[0].ok, true);
  assert.equal(run.results[1].specialist, "dev");
  assert.match(run.results[1].output, /IMPLEMENTED/);
  assert.equal(run.finalDecision?.kind, "done");
  // event ordering
  assert.equal(events[0].type, "run_started");
  assert.equal(events.at(-1)!.type, "run_done");
  assert.ok(events.some((e) => e.type === "orchestrator_decided"));
});

test("specialist activity: engine forwards onActivity lines as specialist_activity events", async () => {
  const defs = [def("dev")];
  const baseFactory = new StubSpecialistFactory(defs, { dev: "done" });
  const factoryProxy: SpecialistSessionFactory & { definitions: SpecialistDefinition[] } = {
    definitions: baseFactory.definitions,
    async create(d) {
      const base = await baseFactory.create(d);
      return {
        name: base.name,
        async run(task, opts) {
          opts?.onActivity?.({ kind: "tool", line: "→ bash npm test" });
          return base.run(task, opts);
        },
        dispose: () => base.dispose(),
      };
    },
  };
  const events: RunEvent[] = [];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator([
      { kind: "run", specialists: [{ specialist: "dev", task: "verify" }], reason: "run dev" },
      { kind: "done", reason: "ok" },
    ]),
    specialistFactory: factoryProxy,
    onEvent: (_run, e) => events.push(e),
  });

  assert.equal(run.status, "done");
  const started = events.find((e) => e.type === "specialist_started");
  const activity = events.find((e) => e.type === "specialist_activity");
  const finished = events.find((e) => e.type === "specialist_finished");
  assert.ok(started);
  assert.ok(activity);
  assert.equal(activity?.details?.line, "→ bash npm test");
  assert.equal(activity?.details?.invocationId, started?.details?.invocationId);
  assert.equal(finished?.details?.invocationId, started?.details?.invocationId);
});

test("parallel isolation: two specialists run concurrently with own sessions", async () => {
  const defs = [def("scout-a"), def("scout-b")];
  // Track overlap: a tiny factory wrapper that timestamps start/finish per specialist.
  const started: Record<string, number> = {};
  const finished: Record<string, number> = {};
  const trackedDefs = defs.map((d) => ({ ...d, name: d.name }));
  const baseFactory = new StubSpecialistFactory(trackedDefs, { "scout-a": "A", "scout-b": "B" }, 50);
  const factoryProxy: SpecialistSessionFactory & { definitions: SpecialistDefinition[] } = {
    definitions: baseFactory.definitions,
    async create(d) {
      const base = await baseFactory.create(d);
      return {
        name: base.name,
        async run(task) {
          started[d.name] = Date.now();
          const r = await base.run(task);
          finished[d.name] = Date.now();
          return r;
        },
        dispose: () => base.dispose(),
      };
    },
  };

  const t0 = Date.now();
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator([
      { kind: "run", specialists: [{ specialist: "scout-a", task: "a" }, { specialist: "scout-b", task: "b" }], reason: "parallel" },
      { kind: "done", reason: "both done" },
    ]),
    specialistFactory: factoryProxy,
  });
  const elapsed = Date.now() - t0;

  assert.equal(run.status, "done");
  assert.equal(run.results.length, 2);
  // both ran
  assert.ok(run.results.find((r) => r.specialist === "scout-a"));
  assert.ok(run.results.find((r) => r.specialist === "scout-b"));
  // they overlapped: not strictly sequential (50ms each would be ~100ms if serial)
  assert.ok(elapsed < 100, `expected parallel (<100ms), got ${elapsed}ms`);
  const a = started["scout-a"], b = started["scout-b"];
  assert.ok(a !== undefined && b !== undefined, "both started");
  // overlap window: a started before b finished and vice versa
  assert.ok(a < finished["scout-b"] && b < finished["scout-a"], "specialists did not overlap");
});

test("escalation: propagates escalate decision and stops", async () => {
  const factory = new StubSpecialistFactory([def("dev")], { dev: "tried, failed" });
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "dev", task: "fix" }], reason: "attempt" },
    { kind: "escalate", reason: "too risky" },
  ];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
  });
  assert.equal(run.status, "escalated");
  assert.equal(run.results.length, 1);
  assert.equal(run.finalDecision?.kind, "escalate");
});

test("iteration cap: engine escalates instead of looping forever", async () => {
  const factory = new StubSpecialistFactory([def("dev")], { dev: "again" });
  const loop: OrchestratorDecision = { kind: "run", specialists: [{ specialist: "dev", task: "go" }], reason: "loop" };
  const script: OrchestratorDecision[] = Array(20).fill(loop); // orchestrator never stops
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
  });
  assert.equal(run.status, "escalated");
  assert.ok(run.results.length <= 7, `should be capped near maxIterations=6, got ${run.results.length}`);
});

test("specialist crash: a throwing specialist becomes a failure, doesn't kill the run", async () => {
  // One specialist throws, one succeeds. The throwing one must become an
  // ok:false result — not reject the whole Promise.all and abandon its sibling.
  const good = def("good");
  const bad = def("bad");
  const baseFactory = new StubSpecialistFactory([good, bad], { good: "done", bad: "should not matter" });
  const factoryProxy: SpecialistSessionFactory & { definitions: SpecialistDefinition[] } = {
    definitions: baseFactory.definitions,
    async create(d) {
      const base = await baseFactory.create(d);
      if (d.name === "bad") {
        return {
          name: d.name,
          async run() { throw new Error("specialist exploded"); },
          dispose: () => base.dispose(),
        };
      }
      return base;
    },
  };
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [
      { specialist: "good", task: "g" },
      { specialist: "bad", task: "b" },
    ], reason: "parallel" },
    { kind: "done", reason: "should be blocked" },
  ];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factoryProxy,
  });
  // both results present — the throwing one didn't abandon the sibling
  assert.equal(run.results.length, 2);
  const goodResult = run.results.find((r) => r.specialist === "good")!;
  const badResult = run.results.find((r) => r.specialist === "bad")!;
  assert.equal(goodResult.ok, true);
  assert.equal(badResult.ok, false);
  assert.match(badResult.error!, /specialist exploded/);
});

test("blocking-failure gate: orchestrator 'done' over a failed result is escalated", async () => {
  // The orchestrator tries to declare done, but the dev specialist failed.
  // The engine's hard gate must convert that into an escalation.
  const factory = new StubSpecialistFactory([def("dev")], { dev: "tried" }, 0, new Set(["dev"]));
  const script: OrchestratorDecision[] = [
    { kind: "run", specialists: [{ specialist: "dev", task: "fix" }], reason: "attempt" },
    { kind: "done", reason: "all good" },
  ];
  const events: RunEvent[] = [];
  const run = await runIssue(issue, {
    provider: new FakeProvider(),
    orchestrator: new ScriptedOrchestrator(script),
    specialistFactory: factory,
    onEvent: (_r, e) => events.push(e),
  });
  assert.equal(run.status, "escalated");
  assert.equal(run.finalDecision?.kind, "escalate");
  assert.match((run.finalDecision as { reason: string }).reason, /failed/);
  assert.ok(events.some((e) => e.type === "gate_blocked"), "gate_blocked event should fire");
});
