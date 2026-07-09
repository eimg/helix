/**
 * Run state persistence. One JSON file per run under `.helix/runs/`.
 * M2: load + incremental save during server-driven runs.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Run, Issue } from "../engine/types.js";

export interface RunSummary {
  id: string;
  title: string;
  status: Run["status"];
  source: Issue["source"];
  startedAt: number;
  finishedAt?: number;
  labels: string[];
  eventCount: number;
}

export interface RunStore {
  save(run: Run): string;
  load(id: string): Run | undefined;
  listSummaries(limit?: number): RunSummary[];
  /** Permanently remove a persisted run. Returns true if something was deleted. */
  delete(id: string): boolean;
}

function toSummary(run: Run): RunSummary {
  return {
    id: run.id,
    title: run.issue.title,
    status: run.status,
    source: run.issue.source,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    labels: run.issue.labels,
    eventCount: run.events.length,
  };
}

function sortSummaries(summaries: RunSummary[], limit?: number): RunSummary[] {
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return limit != null && limit > 0 ? summaries.slice(0, limit) : summaries;
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

  listSummaries(limit?: number): RunSummary[] {
    const summaries: RunSummary[] = [];
    for (const id of this.listIds()) {
      const run = this.load(id);
      if (run) summaries.push(toSummary(run));
    }
    return sortSummaries(summaries, limit);
  }

  delete(id: string): boolean {
    const file = resolve(this.runsDir, `${id}.json`);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
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
  listSummaries(limit?: number): RunSummary[] {
    const summaries = [...this.runs.values()].map(toSummary);
    return sortSummaries(summaries, limit);
  }
  delete(id: string): boolean {
    return this.runs.delete(id);
  }
}
