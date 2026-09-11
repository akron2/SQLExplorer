import { DatabaseSync } from 'node:sqlite';
import type {
  AppMetric,
  MetadataSnapshot,
  OracleClientDefinition,
  OracleSettings,
  PublicConnectionProfile,
  RecentSqlFile,
  SqlDocument,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createDefaultWorkspace } from '../shared/defaults';

const WORKSPACE_KEY = 'workspace';
const ORACLE_SETTINGS_KEY = 'oracle-settings';

function normalizeDocument(value: Partial<SqlDocument>, index: number): SqlDocument {
  const timestamp = new Date().toISOString();
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `migrated-document-${index + 1}`,
    connectionId: typeof value.connectionId === 'string' ? value.connectionId : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : timestamp,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : timestamp,
    dialect: value.dialect === 'oracle' || value.dialect === 'postgres' ? value.dialect : 'sql',
    dirty: Boolean(value.dirty),
    text: typeof value.text === 'string' ? value.text : '',
    title: typeof value.title === 'string' && value.title ? value.title : `SQL ${index + 1}`,
    encoding: typeof value.encoding === 'string' && value.encoding ? value.encoding : 'utf8',
    bom: value.bom ?? 'none',
    eol: value.eol ?? 'lf',
    filePath: typeof value.filePath === 'string' ? value.filePath : undefined,
    diskVersion: value.diskVersion,
    viewState: value.viewState,
  };
}

function migrateWorkspace(value: unknown): WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return createDefaultWorkspace();
  const snapshot = value as Partial<WorkspaceSnapshot> & { schemaVersion?: number };
  if (!Array.isArray(snapshot.documents)) return createDefaultWorkspace();
  const documents = snapshot.documents.map(normalizeDocument);
  if (documents.length === 0) return createDefaultWorkspace();
  const closedDocuments = Array.isArray(snapshot.closedDocuments)
    ? snapshot.closedDocuments.map(normalizeDocument)
    : [];
  const activeDocumentId = documents.some((document) => document.id === snapshot.activeDocumentId)
    ? snapshot.activeDocumentId as string
    : documents[0].id;
  return {
    schemaVersion: 2,
    activeDocumentId,
    documents,
    closedDocuments,
    explorerConnectionId: typeof snapshot.explorerConnectionId === 'string'
      ? snapshot.explorerConnectionId
      : null,
    explorerVisible: snapshot.explorerVisible !== false,
    resultPanelHeight: typeof snapshot.resultPanelHeight === 'number'
      ? snapshot.resultPanelHeight
      : 268,
    theme: snapshot.theme === 'dark' || snapshot.theme === 'light' ? snapshot.theme : 'system',
  };
}

export class WorkspaceStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
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
      CREATE TABLE IF NOT EXISTS connection_profiles (
        id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        profile_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_secrets (
        profile_id TEXT PRIMARY KEY REFERENCES connection_profiles(id) ON DELETE CASCADE,
        encrypted_password TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oracle_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lib_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_files (
        file_path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        opened_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata_cache (
        connection_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  loadWorkspace(): WorkspaceSnapshot {
    const row = this.#database
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(WORKSPACE_KEY) as { value?: string } | undefined;
    if (!row?.value) return createDefaultWorkspace();
    try {
      return migrateWorkspace(JSON.parse(row.value));
    } catch {
      return createDefaultWorkspace();
    }
  }

  saveWorkspace(snapshot: WorkspaceSnapshot): void {
    this.#saveAppState(WORKSPACE_KEY, snapshot);
  }

  listConnectionProfiles(): PublicConnectionProfile[] {
    const rows = this.#database
      .prepare('SELECT profile_json FROM connection_profiles ORDER BY updated_at')
      .all() as Array<{ profile_json: string }>;
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.profile_json) as PublicConnectionProfile];
      } catch {
        return [];
      }
    });
  }

  saveConnectionProfile(profile: PublicConnectionProfile): void {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO connection_profiles (id, profile_json, profile_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile_json = excluded.profile_json,
        profile_version = excluded.profile_version,
        updated_at = excluded.updated_at
    `).run(profile.id, JSON.stringify(profile), profile.profileVersion, now, now);
  }

  deleteConnectionProfile(profileId: string): void {
    this.#database.prepare('DELETE FROM connection_profiles WHERE id = ?').run(profileId);
  }

  hasEncryptedPassword(profileId: string): boolean {
    return Boolean(this.#database
      .prepare('SELECT 1 AS found FROM connection_secrets WHERE profile_id = ?')
      .get(profileId));
  }

  loadEncryptedPassword(profileId: string): string | undefined {
    const row = this.#database
      .prepare('SELECT encrypted_password FROM connection_secrets WHERE profile_id = ?')
      .get(profileId) as { encrypted_password?: string } | undefined;
    return row?.encrypted_password;
  }

  saveEncryptedPassword(profileId: string, encryptedPassword: string): void {
    this.#database.prepare(`
      INSERT INTO connection_secrets (profile_id, encrypted_password, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        encrypted_password = excluded.encrypted_password,
        updated_at = excluded.updated_at
    `).run(profileId, encryptedPassword, new Date().toISOString());
  }

  deleteEncryptedPassword(profileId: string): void {
    this.#database.prepare('DELETE FROM connection_secrets WHERE profile_id = ?').run(profileId);
  }

  listOracleClients(): OracleClientDefinition[] {
    return this.#database.prepare(`
      SELECT id, name, lib_dir FROM oracle_clients ORDER BY name COLLATE NOCASE
    `).all().map((row) => {
      const value = row as { id: string; lib_dir: string; name: string };
      return { id: value.id, name: value.name, libDir: value.lib_dir };
    });
  }

  saveOracleClient(client: OracleClientDefinition): void {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO oracle_clients (id, name, lib_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        lib_dir = excluded.lib_dir,
        updated_at = excluded.updated_at
    `).run(client.id, client.name, client.libDir, now, now);
  }

  deleteOracleClient(clientId: string): void {
    this.#database.prepare('DELETE FROM oracle_clients WHERE id = ?').run(clientId);
  }

  loadOracleSettings(): OracleSettings {
    const row = this.#database.prepare('SELECT value FROM app_state WHERE key = ?')
      .get(ORACLE_SETTINGS_KEY) as { value?: string } | undefined;
    if (!row?.value) return { defaultNetConfigDir: '' };
    try {
      const value = JSON.parse(row.value) as Partial<OracleSettings>;
      return { defaultNetConfigDir: value.defaultNetConfigDir ?? '' };
    } catch {
      return { defaultNetConfigDir: '' };
    }
  }

  saveOracleSettings(settings: OracleSettings): void {
    this.#saveAppState(ORACLE_SETTINGS_KEY, settings);
  }

  saveRecentFile(filePath: string, title: string): void {
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO recent_files (file_path, title, opened_at)
      VALUES (?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET title = excluded.title, opened_at = excluded.opened_at
    `).run(filePath, title, now);
    const stale = this.#database.prepare(`
      SELECT file_path FROM recent_files ORDER BY opened_at DESC LIMIT -1 OFFSET 20
    `).all() as Array<{ file_path: string }>;
    const remove = this.#database.prepare('DELETE FROM recent_files WHERE file_path = ?');
    for (const row of stale) remove.run(row.file_path);
  }

  listRecentFiles(): RecentSqlFile[] {
    return this.#database.prepare(`
      SELECT file_path, title, opened_at FROM recent_files ORDER BY opened_at DESC LIMIT 20
    `).all().map((row) => {
      const value = row as { file_path: string; opened_at: string; title: string };
      return { filePath: value.file_path, title: value.title, openedAt: value.opened_at };
    });
  }

  saveMetadata(snapshot: MetadataSnapshot): void {
    this.#database.prepare(`
      INSERT INTO metadata_cache (connection_id, snapshot_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(snapshot.connectionId, JSON.stringify(snapshot), new Date().toISOString());
  }

  listMetadata(): MetadataSnapshot[] {
    const rows = this.#database.prepare('SELECT snapshot_json FROM metadata_cache')
      .all() as Array<{ snapshot_json: string }>;
    return rows.flatMap((row) => {
      try {
        return [{ ...JSON.parse(row.snapshot_json) as MetadataSnapshot, stale: true }];
      } catch {
        return [];
      }
    });
  }

  deleteMetadata(connectionId: string): void {
    this.#database.prepare('DELETE FROM metadata_cache WHERE connection_id = ?').run(connectionId);
  }

  recordMetric(metric: AppMetric): void {
    this.#database.prepare(`
      INSERT INTO performance_metrics (name, duration_ms, detail, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(
      metric.name,
      metric.durationMs,
      metric.detail ? JSON.stringify(metric.detail) : null,
      metric.recordedAt,
    );
  }

  close(): void {
    this.#database.close();
  }

  #saveAppState(key: string, value: unknown): void {
    this.#database.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }
}

export { migrateWorkspace };
