import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Small durable key/value store for Helix-local operator settings (e.g. Steering URL).
 * Lives beside runs.db under `.helix/` so MemoryRunStore tests and SqliteRunStore
 * share the same settings seam.
 */
export class AppSettingsStore {
  private readonly db: Database.Database;

  constructor(helixDir: string) {
    mkdirSync(helixDir, { recursive: true });
    this.db = new Database(join(helixDir, "app_settings.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }
}
