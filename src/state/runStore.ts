/**
 * Run state persistence — append-only write of a Run (+ its events) to
 * `.helix/runs/<run-id>.json`. v1: one file per run, written at the end.
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
