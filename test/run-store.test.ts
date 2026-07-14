import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunStore, SqliteRunStore } from "../src/state/runStore.js";
import type { Run } from "../src/engine/types.js";

function sampleRun(id: string): Run {
  return {
    id,
    issue: { source: "inline", title: `Run ${id}`, body: "", labels: ["test"] },
    startedAt: 100,
    status: "running",
    events: [{ ts: 100, type: "run_started", summary: "started" }],
    results: [],
    knowledge: [],
  };
}

test("SqliteRunStore incrementally persists and reconstructs a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-store-"));
  const store = new SqliteRunStore(join(dir, "runs.db"));
  const run = sampleRun("one");
  store.save(run);

  run.events.push({ ts: 101, type: "specialist_started", summary: "dev" });
  run.results.push({ specialist: "dev", task: "work", ok: true, output: "complete" });
  run.knowledge?.push({ specialist: "dev", ok: true, summary: "complete", relevantPaths: [], verifiedCommands: [] });
  run.status = "done";
  run.finishedAt = 102;
  store.save(run);

  assert.deepEqual(store.load("one"), run);
  assert.equal(store.listSummaries()[0].eventCount, 2);
  assert.equal(store.listSummaries()[0].status, "done");
  assert.equal(store.delete("one"), true);
  assert.equal(store.load("one"), undefined);
});

test("SqliteRunStore imports legacy JSON runs when the database is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "helix-store-legacy-"));
  const legacyDir = join(dir, "runs");
  const legacy = new FileRunStore(legacyDir);
  legacy.save(sampleRun("legacy"));

  const store = new SqliteRunStore(join(dir, "runs.db"), legacyDir);
  assert.equal(store.load("legacy")?.issue.title, "Run legacy");
  assert.equal(store.listSummaries().length, 1);
});
