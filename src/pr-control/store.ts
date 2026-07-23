import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { PullRequestReview } from "./types.js";

export interface PullRequestReviewStore {
  save(review: PullRequestReview): void;
  load(id: string): PullRequestReview | undefined;
  list(limit?: number): PullRequestReview[];
  findByExternalEvent(externalEventId: string): PullRequestReview | undefined;
}

interface ReviewRow {
  json: string;
}

export class SqlitePullRequestReviewStore implements PullRequestReviewStore {
  private readonly db: Database.Database;

  constructor(databaseFile: string) {
    mkdirSync(dirname(databaseFile), { recursive: true });
    this.db = new Database(databaseFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pull_request_reviews (
        id TEXT PRIMARY KEY,
        external_event_id TEXT NOT NULL UNIQUE,
        tracker_url TEXT NOT NULL,
        pull_request_id INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pull_request_reviews_started
        ON pull_request_reviews(started_at DESC);
      CREATE INDEX IF NOT EXISTS pull_request_reviews_pr_head
        ON pull_request_reviews(tracker_url, pull_request_id, head_sha);
    `);
  }

  save(review: PullRequestReview): void {
    this.db.prepare(`
      INSERT INTO pull_request_reviews (
        id, external_event_id, tracker_url, pull_request_id, head_sha,
        status, started_at, finished_at, json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        finished_at = excluded.finished_at,
        json = excluded.json
    `).run(
      review.id,
      review.request.externalEventId,
      review.request.callback.trackerUrl,
      review.request.callback.pullRequestId,
      review.request.pullRequest.headSha,
      review.status,
      review.startedAt,
      review.finishedAt ?? null,
      JSON.stringify(review),
    );
  }

  load(id: string): PullRequestReview | undefined {
    const row = this.db.prepare("SELECT json FROM pull_request_reviews WHERE id = ?").get(id) as ReviewRow | undefined;
    return row ? parseReview(row.json) : undefined;
  }

  list(limit = 100): PullRequestReview[] {
    const rows = this.db.prepare(`
      SELECT json FROM pull_request_reviews ORDER BY started_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 500))) as ReviewRow[];
    return rows.map((row) => parseReview(row.json));
  }

  findByExternalEvent(externalEventId: string): PullRequestReview | undefined {
    const row = this.db.prepare(
      "SELECT json FROM pull_request_reviews WHERE external_event_id = ?",
    ).get(externalEventId) as ReviewRow | undefined;
    return row ? parseReview(row.json) : undefined;
  }
}

function parseReview(json: string): PullRequestReview {
  const review = JSON.parse(json) as PullRequestReview;
  review.events ??= [];
  return review;
}

export class MemoryPullRequestReviewStore implements PullRequestReviewStore {
  readonly reviews = new Map<string, PullRequestReview>();

  save(review: PullRequestReview): void {
    this.reviews.set(review.id, structuredClone(review));
  }

  load(id: string): PullRequestReview | undefined {
    const review = this.reviews.get(id);
    return review ? structuredClone(review) : undefined;
  }

  list(limit = 100): PullRequestReview[] {
    return [...this.reviews.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((review) => structuredClone(review));
  }

  findByExternalEvent(externalEventId: string): PullRequestReview | undefined {
    const review = [...this.reviews.values()].find(
      (item) => item.request.externalEventId === externalEventId,
    );
    return review ? structuredClone(review) : undefined;
  }
}
