/**
 * Run state persistence. v1: one JSON file per run under `.helix/runs/`,
 * written when `save()` is called (the CLI calls it once at the end of a run).
 * Incremental persistence during a long run is a future concern; today a crash
 * mid-run loses state, which is acceptable for M1's manual/CLI shape.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Run } from "../engine/types.js";

export interface RunStore {
  save(run: Run): string;
}

export class FileRunStore implements RunStore {
  constructor(private readonly runsDir: string) {}

  save(run: Run): string {
    mkdirSync(this.runsDir, { recursive: true });
    const file = resolve(this.runsDir, `${run.id}.json`);
    writeFileSync(file, JSON.stringify(run, null, 2), "utf-8");
    return file;
  }
}

/** In-memory store for tests. */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, Run>();
  save(run: Run): string {
    this.runs.set(run.id, run);
    return `memory://${run.id}`;
  }
}
