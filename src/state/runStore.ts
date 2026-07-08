/**
 * Run state persistence. One JSON file per run under `.helix/runs/`.
 * M2: load + incremental save during server-driven runs.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Run } from "../engine/types.js";

export interface RunStore {
  save(run: Run): string;
  load(id: string): Run | undefined;
}

export class FileRunStore implements RunStore {
  constructor(private readonly runsDir: string) {}

  save(run: Run): string {
    mkdirSync(this.runsDir, { recursive: true });
    const file = resolve(this.runsDir, `${run.id}.json`);
    writeFileSync(file, JSON.stringify(run, null, 2), "utf-8");
    return file;
  }

  load(id: string): Run | undefined {
    const file = resolve(this.runsDir, `${id}.json`);
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as Run;
    } catch {
      return undefined;
    }
  }

  listIds(): string[] {
    try {
      return readdirSync(this.runsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }
}

/** In-memory store for tests. */
export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, Run>();
  save(run: Run): string {
    this.runs.set(run.id, structuredClone(run));
    return `memory://${run.id}`;
  }
  load(id: string): Run | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }
}
