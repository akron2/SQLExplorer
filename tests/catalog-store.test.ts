// @vitest-environment node

import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/main/workspace-store';

const createdFiles: string[] = [];

function temporaryFile(): string {
  const file = path.join(tmpdir(), `sqlexplorer-catalog-${crypto.randomUUID()}.sqlite`);
  createdFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const suffix of ['', '-shm', '-wal']) {
      const value = `${file}${suffix}`;
      if (existsSync(value)) rmSync(value, { force: true });
    }
  }
});

describe('CatalogStore', () => {
  it('stores schemas, objects and columns with prefix search', () => {
    const store = new WorkspaceStore(temporaryFile());
    store.catalog.syncSchemas('c1', ['SQLX', 'PUBLIC'], 'SQLX');
    store.catalog.storeObjects('c1', 'SQLX', [
      { kind: 'table', schema: 'SQLX', name: 'EMPLOYEES' },
      { kind: 'view', schema: 'SQLX', name: 'EMPLOYEE_DETAILS' },
      { kind: 'package', schema: 'SQLX', name: 'DEMO_PKG' },
    ]);
    store.catalog.storeObjects('c1', 'PUBLIC', [
      { kind: 'synonym', schema: 'PUBLIC', name: 'DUAL' },
    ]);

    const unquoted = store.catalog.queryObjects({
      connectionId: 'c1', schema: 'SQLX', prefix: 'emp', limit: 10,
    });
    expect(unquoted.objects.map((object) => object.name))
      .toEqual(['EMPLOYEE_DETAILS', 'EMPLOYEES']);

    const quoted = store.catalog.queryObjects({
      connectionId: 'c1', schema: 'SQLX', prefix: 'emp', caseSensitive: true, limit: 10,
    });
    expect(quoted.objects).toHaveLength(0);

    const kinds = store.catalog.queryObjects({
      connectionId: 'c1', schema: 'SQLX', prefix: '', limit: 10, kinds: ['package'],
    });
    expect(kinds.objects.map((object) => object.name)).toEqual(['DEMO_PKG']);

    const substring = store.catalog.queryObjects({
      connectionId: 'c1', schema: 'SQLX', prefix: 'pkg', substring: true, limit: 10,
    });
    expect(substring.objects.map((object) => object.name)).toEqual(['DEMO_PKG']);

    store.catalog.storeColumns('c1', 'SQLX', 'EMPLOYEES', [
      { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
      { name: 'FULL_NAME', dataType: 'VARCHAR2(120)', nullable: false, position: 2 },
    ]);
    expect(store.catalog.getColumns('c1', 'SQLX', 'EMPLOYEES')).toHaveLength(2);
    store.catalog.storeColumns('c1', 'SQLX', 'EMPLOYEES', [
      { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
    ]);
    expect(store.catalog.getColumns('c1', 'SQLX', 'EMPLOYEES')).toHaveLength(1);
    store.close();
  });

  it('detects truncation and resolves schema names', () => {
    const store = new WorkspaceStore(temporaryFile());
    store.catalog.syncSchemas('c1', ['SQLX', 'PUBLIC'], 'SQLX');
    store.catalog.storeObjects('c1', 'SQLX', Array.from({ length: 5 }, (_, index) => ({
      kind: 'table' as const,
      schema: 'SQLX',
      name: `TABLE_${index}`,
    })));
    const page = store.catalog.queryObjects({ connectionId: 'c1', schema: 'SQLX', prefix: 'TABLE', limit: 3 });
    expect(page.objects).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(store.catalog.resolveSchemaName('c1', 'sqlx', false)).toBe('SQLX');
    expect(store.catalog.resolveSchemaName('c1', 'sqlx', true)).toBeUndefined();
    store.close();
  });

  it('marks loaded and on-demand schemas and invalidates them', () => {
    const store = new WorkspaceStore(temporaryFile());
    store.catalog.syncSchemas('c1', ['SMALL', 'HUGE'], 'SMALL');
    store.catalog.markSchemaLoaded('c1', 'SMALL', 42);
    store.catalog.markSchemaOnDemand('c1', 'HUGE', 200_000);
    store.catalog.storeObjects('c1', 'HUGE', [{ kind: 'table', schema: 'HUGE', name: 'T1' }]);

    const schemas = store.catalog.listSchemas('c1');
    expect(schemas.find((schema) => schema.name === 'SMALL')).toMatchObject({
      loaded: true, objectCount: 42,
    });
    expect(schemas.find((schema) => schema.name === 'HUGE')).toMatchObject({
      loaded: false, objectCount: 200_000,
    });
    expect(store.catalog.counts('c1')).toEqual({ loaded: 1, total: 2 });

    store.catalog.invalidateSchema('c1', 'HUGE');
    expect(store.catalog.queryObjects({ connectionId: 'c1', schema: 'HUGE', prefix: '', limit: 10 }).objects)
      .toHaveLength(0);
    expect(store.catalog.schemaInfo('c1', 'HUGE')).toMatchObject({ loaded: false, stale: true });

    store.catalog.syncSchemas('c1', ['SMALL'], 'SMALL');
    expect(store.catalog.listSchemas('c1').map((schema) => schema.name)).toEqual(['SMALL']);

    store.catalog.invalidateConnection('c1');
    expect(store.catalog.listSchemas('c1')).toHaveLength(0);
    expect(store.catalog.getContext('c1')).toBeUndefined();
    store.close();
  });

  it('keeps prefix queries fast on a 200k object catalog', { timeout: 120_000 }, () => {
    const file = temporaryFile();
    const store = new WorkspaceStore(file);
    store.catalog.syncSchemas('big', ['PUBLIC'], 'PUBLIC');
    const bulk = new DatabaseSync(file);
    bulk.exec('BEGIN');
    const insert = bulk.prepare(`
      INSERT INTO catalog_object (connection_id, schema, name, kind, search_key, loaded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const loadedAt = new Date().toISOString();
    for (let index = 0; index < 200_000; index += 1) {
      const name = `TABLE_${index.toString().padStart(6, '0')}`;
      insert.run('big', 'PUBLIC', name, 'table', name.toLocaleLowerCase(), loadedAt);
    }
    bulk.exec('COMMIT');
    bulk.close();

    const started = performance.now();
    const page = store.catalog.queryObjects({
      connectionId: 'big', schema: 'PUBLIC', prefix: 'TABLE_012', limit: 200,
    });
    const elapsed = performance.now() - started;
    store.close();
    expect(page.objects).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
