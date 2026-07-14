/**
 * Run state persistence. SQLite is the default; FileRunStore remains for
 * legacy import and compatibility tests.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Run, Issue, RunEvent, SpecialistResult } from "../engine/types.js";

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

interface CountRow { count: number }
interface JsonRow { json: string }
interface SummaryRow {
  id: string;
  title: string;
  status: Run["status"];
  source: Issue["source"];
  started_at: number;
  finished_at: number | null;
  labels_json: string;
  event_count: number;
}

/**
 * Default durable store. Run metadata, events, and results are separated so an
 * event append does not rewrite an ever-growing JSON snapshot.
 */
export class SqliteRunStore implements RunStore {
  private readonly db: Database.Database;
  private readonly saveTransaction: (run: Run) => void;

  constructor(
    private readonly databaseFile: string,
    legacyRunsDir?: string,
  ) {
    mkdirSync(dirname(databaseFile), { recursive: true });
    this.db = new Database(databaseFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        labels_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        result_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS run_results (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at DESC);
    `);
    this.saveTransaction = this.db.transaction((run: Run) => this.persist(run));
    if (legacyRunsDir) this.importLegacyRuns(legacyRunsDir);
  }

  save(run: Run): string {
    this.saveTransaction(run);
    return `${this.databaseFile}#${run.id}`;
  }

  load(id: string): Run | undefined {
    const row = this.db.prepare("SELECT metadata_json FROM runs WHERE id = ?").get(id) as { metadata_json: string } | undefined;
    if (!row) return undefined;
    const metadata = JSON.parse(row.metadata_json) as Omit<Run, "events" | "results">;
    const events = this.db.prepare("SELECT json FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as JsonRow[];
    const results = this.db.prepare("SELECT json FROM run_results WHERE run_id = ? ORDER BY seq").all(id) as JsonRow[];
    return {
      ...metadata,
      events: events.map((item) => JSON.parse(item.json) as RunEvent),
      results: results.map((item) => JSON.parse(item.json) as SpecialistResult),
    };
  }

  listSummaries(limit?: number): RunSummary[] {
    const bounded = limit != null && limit > 0 ? limit : 10_000;
    const rows = this.db.prepare(`
      SELECT id, title, status, source, started_at, finished_at, labels_json, event_count
      FROM runs ORDER BY started_at DESC LIMIT ?
    `).all(bounded) as SummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      source: row.source,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      labels: JSON.parse(row.labels_json) as string[],
      eventCount: row.event_count,
    }));
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
  }

  private persist(run: Run): void {
    const { events, results, ...metadata } = run;
    this.db.prepare(`
      INSERT INTO runs (
        id, title, status, source, started_at, finished_at, labels_json,
        metadata_json, event_count, result_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        source = excluded.source,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        labels_json = excluded.labels_json,
        metadata_json = excluded.metadata_json,
        event_count = excluded.event_count,
        result_count = excluded.result_count
    `).run(
      run.id,
      run.issue.title,
      run.status,
      run.issue.source,
      run.startedAt,
      run.finishedAt ?? null,
      JSON.stringify(run.issue.labels),
      JSON.stringify(metadata),
      events.length,
      results.length,
    );

    this.appendRows("run_events", run.id, events);
    this.appendRows("run_results", run.id, results);
  }

  private appendRows(table: "run_events" | "run_results", runId: string, values: unknown[]): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId) as CountRow;
    if (count.count > values.length) {
      this.db.prepare(`DELETE FROM ${table} WHERE run_id = ? AND seq >= ?`).run(runId, values.length);
    }
    const insert = this.db.prepare(`INSERT OR REPLACE INTO ${table} (run_id, seq, json) VALUES (?, ?, ?)`);
    for (let index = Math.min(count.count, values.length); index < values.length; index++) {
      insert.run(runId, index, JSON.stringify(values[index]));
    }
  }

  private importLegacyRuns(legacyRunsDir: string): void {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM runs").get() as CountRow;
    if (count.count > 0 || !existsSync(legacyRunsDir)) return;
    const legacy = new FileRunStore(legacyRunsDir);
    for (const id of legacy.listIds()) {
      const run = legacy.load(id);
      if (run) this.saveTransaction(run);
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
