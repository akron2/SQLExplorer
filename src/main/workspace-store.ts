import { DatabaseSync } from 'node:sqlite';
import type { AppMetric, WorkspaceSnapshot } from '../shared/contracts';
import { createDefaultWorkspace } from '../shared/defaults';

const WORKSPACE_KEY = 'workspace';

export class WorkspaceStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS performance_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        detail TEXT,
        recorded_at TEXT NOT NULL
      );
    `);
  }

  loadWorkspace(): WorkspaceSnapshot {
    const row = this.#database
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(WORKSPACE_KEY) as { value?: string } | undefined;

    if (!row?.value) {
      return createDefaultWorkspace();
    }

    try {
      const snapshot = JSON.parse(row.value) as Partial<WorkspaceSnapshot>;
      if (
        snapshot.schemaVersion !== 1 ||
        !Array.isArray(snapshot.documents) ||
        typeof snapshot.activeDocumentId !== 'string'
      ) {
        return createDefaultWorkspace();
      }
      return snapshot as WorkspaceSnapshot;
    } catch {
      return createDefaultWorkspace();
    }
  }

  saveWorkspace(snapshot: WorkspaceSnapshot): void {
    const statement = this.#database.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    statement.run(WORKSPACE_KEY, JSON.stringify(snapshot), new Date().toISOString());
  }

  recordMetric(metric: AppMetric): void {
    this.#database
      .prepare(`
        INSERT INTO performance_metrics (name, duration_ms, detail, recorded_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        metric.name,
        metric.durationMs,
        metric.detail ? JSON.stringify(metric.detail) : null,
        metric.recordedAt,
      );
  }

  close(): void {
    this.#database.close();
  }
}
