import type { DatabaseSync } from 'node:sqlite';
import type {
  CatalogAccessContext,
  CatalogColumn,
  CatalogObjectKind,
  CatalogObjectSummary,
  CatalogSchemaSummary,
} from '../shared/contracts';

const MAX_LIMIT = 1_000;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

export interface CatalogObjectLookup {
  caseSensitive?: boolean;
  connectionId: string;
  kinds?: CatalogObjectKind[];
  limit: number;
  offset?: number;
  prefix: string;
  schema: string;
  substring?: boolean;
}

export interface CatalogObjectResult {
  hasMore: boolean;
  objects: CatalogObjectSummary[];
}

export class CatalogStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      DROP TABLE IF EXISTS metadata_cache;
      CREATE TABLE IF NOT EXISTS catalog_context (
        connection_id TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        current_schema TEXT NOT NULL,
        search_path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'catalog',
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_schema (
        connection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        object_count INTEGER NOT NULL DEFAULT 0,
        loaded_at TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (connection_id, name)
      );
      CREATE TABLE IF NOT EXISTS catalog_object (
        connection_id TEXT NOT NULL,
        schema TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        search_key TEXT NOT NULL,
        loaded_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, schema, name, kind)
      );
      CREATE INDEX IF NOT EXISTS catalog_object_schema_idx
        ON catalog_object (connection_id, schema, search_key);
      CREATE INDEX IF NOT EXISTS catalog_object_search_idx
        ON catalog_object (connection_id, search_key);
      CREATE TABLE IF NOT EXISTS catalog_column (
        connection_id TEXT NOT NULL,
        schema TEXT NOT NULL,
        object TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        data_type TEXT NOT NULL,
        nullable INTEGER NOT NULL,
        PRIMARY KEY (connection_id, schema, object, position)
      );
    `);
  }

  getContext(connectionId: string): CatalogAccessContext | undefined {
    const row = this.database.prepare(`
      SELECT connection_id, user_name, current_schema, search_path, source, fetched_at
      FROM catalog_context WHERE connection_id = ?
    `).get(connectionId) as {
      connection_id: string;
      current_schema: string;
      fetched_at: string;
      search_path: string;
      source: string;
      user_name: string;
    } | undefined;
    if (!row) return undefined;
    return {
      connectionId: row.connection_id,
      userName: row.user_name,
      currentSchema: row.current_schema,
      searchPath: this.#parseSearchPath(row.search_path),
      source: row.source === 'session' ? 'session' : 'catalog',
      fetchedAt: row.fetched_at,
    };
  }

  saveContext(context: CatalogAccessContext): void {
    this.database.prepare(`
      INSERT INTO catalog_context (connection_id, user_name, current_schema, search_path, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        user_name = excluded.user_name,
        current_schema = excluded.current_schema,
        search_path = excluded.search_path,
        source = excluded.source,
        fetched_at = excluded.fetched_at
    `).run(
      context.connectionId,
      context.userName,
      context.currentSchema,
      JSON.stringify(context.searchPath),
      context.source,
      context.fetchedAt,
    );
  }

  syncSchemas(connectionId: string, names: string[], defaultSchema: string): void {
    const normalizedDefault = defaultSchema.toLocaleLowerCase();
    const wanted = new Map(names.map((name) => [name.toLocaleLowerCase(), name]));
    const existing = this.database.prepare(
      'SELECT name FROM catalog_schema WHERE connection_id = ?',
    ).all(connectionId) as Array<{ name: string }>;
    const removeObjects = this.database.prepare(
      'DELETE FROM catalog_object WHERE connection_id = ? AND schema = ?',
    );
    const removeColumns = this.database.prepare(
      'DELETE FROM catalog_column WHERE connection_id = ? AND schema = ?',
    );
    const removeSchema = this.database.prepare(
      'DELETE FROM catalog_schema WHERE connection_id = ? AND name = ?',
    );
    for (const row of existing) {
      if (wanted.has(row.name.toLocaleLowerCase())) continue;
      removeObjects.run(connectionId, row.name);
      removeColumns.run(connectionId, row.name);
      removeSchema.run(connectionId, row.name);
    }
    const upsert = this.database.prepare(`
      INSERT INTO catalog_schema (connection_id, name, is_default, object_count, loaded_at, stale)
      VALUES (?, ?, ?, 0, NULL, 0)
      ON CONFLICT(connection_id, name) DO UPDATE SET is_default = excluded.is_default
    `);
    for (const name of names) {
      upsert.run(connectionId, name, name.toLocaleLowerCase() === normalizedDefault ? 1 : 0);
    }
  }

  listSchemas(connectionId: string, search?: string): CatalogSchemaSummary[] {
    const rows = this.database.prepare(`
      SELECT name, is_default, object_count, loaded_at, stale
      FROM catalog_schema WHERE connection_id = ?
      ORDER BY is_default DESC, name COLLATE NOCASE
    `).all(connectionId) as Array<{
      is_default: number;
      loaded_at: string | null;
      name: string;
      object_count: number;
      stale: number;
    }>;
    const value = search?.trim().toLocaleLowerCase();
    return rows
      .filter((row) => !value || row.name.toLocaleLowerCase().includes(value))
      .map((row) => ({
        name: row.name,
        isDefault: Boolean(row.is_default),
        objectCount: row.object_count,
        loaded: Boolean(row.loaded_at),
        stale: Boolean(row.stale),
      }));
  }

  schemaInfo(connectionId: string, name: string): CatalogSchemaSummary | undefined {
    const row = this.database.prepare(`
      SELECT name, is_default, object_count, loaded_at, stale
      FROM catalog_schema WHERE connection_id = ? AND name = ?
    `).get(connectionId, name) as {
      is_default: number;
      loaded_at: string | null;
      name: string;
      object_count: number;
      stale: number;
    } | undefined;
    if (!row) return undefined;
    return {
      name: row.name,
      isDefault: Boolean(row.is_default),
      objectCount: row.object_count,
      loaded: Boolean(row.loaded_at),
      stale: Boolean(row.stale),
    };
  }

  resolveSchemaName(connectionId: string, name: string, caseSensitive: boolean): string | undefined {
    const row = caseSensitive
      ? this.database.prepare(
        'SELECT name FROM catalog_schema WHERE connection_id = ? AND name = ?',
      ).get(connectionId, name) as { name: string } | undefined
      : this.database.prepare(
        'SELECT name FROM catalog_schema WHERE connection_id = ? AND lower(name) = lower(?)',
      ).get(connectionId, name) as { name: string } | undefined;
    return row?.name;
  }

  markSchemaLoaded(connectionId: string, schema: string, objectCount: number): void {
    this.database.prepare(`
      UPDATE catalog_schema SET object_count = ?, loaded_at = ?, stale = 0
      WHERE connection_id = ? AND name = ?
    `).run(objectCount, new Date().toISOString(), connectionId, schema);
  }

  markSchemaOnDemand(connectionId: string, schema: string, objectCount: number): void {
    this.database.prepare(`
      UPDATE catalog_schema SET object_count = ?, loaded_at = NULL, stale = 0
      WHERE connection_id = ? AND name = ?
    `).run(objectCount, connectionId, schema);
  }

  markSchemaStale(connectionId: string, schema: string): void {
    this.database.prepare(`
      UPDATE catalog_schema SET stale = 1, loaded_at = NULL
      WHERE connection_id = ? AND name = ?
    `).run(connectionId, schema);
  }

  clearSchemaObjects(connectionId: string, schema: string): void {
    this.database.prepare(
      'DELETE FROM catalog_object WHERE connection_id = ? AND schema = ?',
    ).run(connectionId, schema);
  }

  storeObjects(connectionId: string, schema: string, objects: CatalogObjectSummary[]): void {
    const statement = this.database.prepare(`
      INSERT INTO catalog_object (connection_id, schema, name, kind, search_key, loaded_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, schema, name, kind) DO UPDATE SET
        search_key = excluded.search_key,
        loaded_at = excluded.loaded_at
    `);
    const loadedAt = new Date().toISOString();
    for (const object of objects) {
      statement.run(
        connectionId,
        schema,
        object.name,
        object.kind,
        object.name.toLocaleLowerCase(),
        loadedAt,
      );
    }
  }

  queryObjects(lookup: CatalogObjectLookup): CatalogObjectResult {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(lookup.limit)));
    const offset = Math.max(0, Math.trunc(lookup.offset ?? 0));
    const conditions = ['connection_id = ?', 'schema = ?'];
    const params: Array<number | string> = [lookup.connectionId, lookup.schema];
    if (lookup.kinds?.length) {
      conditions.push(`kind IN (${lookup.kinds.map(() => '?').join(', ')})`);
      params.push(...lookup.kinds);
    }
    const prefix = lookup.prefix ?? '';
    if (prefix) {
      if (lookup.caseSensitive) {
        if (lookup.substring) {
          conditions.push('instr(name, ?) > 0');
          params.push(prefix);
        } else {
          conditions.push('substr(name, 1, ?) = ?');
          params.push(prefix.length, prefix);
        }
      } else {
        conditions.push(`search_key LIKE ? ESCAPE '\\'`);
        params.push(lookup.substring
          ? `%${escapeLike(prefix.toLocaleLowerCase())}%`
          : `${escapeLike(prefix.toLocaleLowerCase())}%`);
      }
    }
    const rows = this.database.prepare(`
      SELECT schema, name, kind FROM catalog_object
      WHERE ${conditions.join(' AND ')}
      ORDER BY search_key, name, kind
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset) as Array<{ kind: string; name: string; schema: string }>;
    const hasMore = rows.length > limit;
    return {
      hasMore,
      objects: rows.slice(0, limit).map((row) => ({
        schema: row.schema,
        name: row.name,
        kind: row.kind as CatalogObjectKind,
      })),
    };
  }

  getColumns(connectionId: string, schema: string, object: string): CatalogColumn[] {
    return this.database.prepare(`
      SELECT name, data_type, nullable, position FROM catalog_column
      WHERE connection_id = ? AND schema = ? AND object = ?
      ORDER BY position
    `).all(connectionId, schema, object).map((row) => {
      const value = row as { data_type: string; name: string; nullable: number; position: number };
      return {
        name: value.name,
        dataType: value.data_type,
        nullable: Boolean(value.nullable),
        position: value.position,
      };
    });
  }

  storeColumns(connectionId: string, schema: string, object: string, columns: CatalogColumn[]): void {
    this.database.prepare(
      'DELETE FROM catalog_column WHERE connection_id = ? AND schema = ? AND object = ?',
    ).run(connectionId, schema, object);
    const statement = this.database.prepare(`
      INSERT INTO catalog_column (connection_id, schema, object, position, name, data_type, nullable)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const column of columns) {
      statement.run(
        connectionId,
        schema,
        object,
        column.position,
        column.name,
        column.dataType,
        column.nullable ? 1 : 0,
      );
    }
  }

  counts(connectionId: string): { loaded: number; total: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN loaded_at IS NOT NULL THEN 1 ELSE 0 END) AS loaded
      FROM catalog_schema WHERE connection_id = ?
    `).get(connectionId) as { loaded: number | null; total: number } | undefined;
    return { total: row?.total ?? 0, loaded: row?.loaded ?? 0 };
  }

  invalidateSchema(connectionId: string, schema: string): void {
    this.clearSchemaObjects(connectionId, schema);
    this.database.prepare(
      'DELETE FROM catalog_column WHERE connection_id = ? AND schema = ?',
    ).run(connectionId, schema);
    this.markSchemaStale(connectionId, schema);
  }

  invalidateConnection(connectionId: string): void {
    this.database.prepare('DELETE FROM catalog_object WHERE connection_id = ?').run(connectionId);
    this.database.prepare('DELETE FROM catalog_column WHERE connection_id = ?').run(connectionId);
    this.database.prepare('DELETE FROM catalog_schema WHERE connection_id = ?').run(connectionId);
    this.database.prepare('DELETE FROM catalog_context WHERE connection_id = ?').run(connectionId);
  }

  markConnectionStale(connectionId: string): void {
    this.database.prepare(
      'UPDATE catalog_schema SET stale = 1, loaded_at = NULL WHERE connection_id = ?',
    ).run(connectionId);
  }

  #parseSearchPath(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      // Fall through to the text form.
    }
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
}
