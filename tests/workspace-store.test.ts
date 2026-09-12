// @vitest-environment node

import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/main/workspace-store';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    if (existsSync(file)) rmSync(file, { force: true });
    if (existsSync(`${file}-shm`)) rmSync(`${file}-shm`, { force: true });
    if (existsSync(`${file}-wal`)) rmSync(`${file}-wal`, { force: true });
  }
});

describe('WorkspaceStore', () => {
  it('persists and reloads a workspace snapshot', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const first = new WorkspaceStore(file);
    const workspace = first.loadWorkspace();
    const changed = { ...workspace, theme: 'dark' as const };
    first.saveWorkspace(changed);
    first.close();

    const second = new WorkspaceStore(file);
    expect(second.loadWorkspace().theme).toBe('dark');
    second.close();
  });

  it('records performance metrics', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const store = new WorkspaceStore(file);
    expect(() => store.recordMetric({
      name: 'test',
      durationMs: 12.5,
      recordedAt: new Date().toISOString(),
      detail: { documents: 20 },
    })).not.toThrow();
    store.close();
  });

  it('migrates a version 1 workspace without losing SQL text', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const initial = new WorkspaceStore(file);
    initial.close();
    const database = new DatabaseSync(file);
    const legacy = {
      schemaVersion: 1,
      activeDocumentId: 'legacy',
      closedDocuments: [],
      documents: [{
        id: 'legacy', connectionId: 'removed-profile', dialect: 'oracle', dirty: true,
        title: 'legacy.sql', text: 'select * from legacy_table;',
        createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      }],
      explorerConnectionId: 'removed-profile',
      explorerVisible: true,
      resultPanelHeight: 300,
      theme: 'dark',
    };
    database.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('workspace', JSON.stringify(legacy), new Date().toISOString());
    database.close();

    const migratedStore = new WorkspaceStore(file);
    const migrated = migratedStore.loadWorkspace();
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.documents[0]).toMatchObject({
      id: 'legacy', text: 'select * from legacy_table;', encoding: 'utf8', bom: 'none', eol: 'lf',
    });
    migratedStore.close();
  });

  it('persists recent files and stores catalog entries', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const store = new WorkspaceStore(file);
    store.saveRecentFile('C:\\sql\\one.sql', 'one.sql');
    store.catalog.syncSchemas('profile-1', ['PUBLIC'], 'PUBLIC');
    store.catalog.storeObjects('profile-1', 'PUBLIC', [
      { kind: 'table', name: 'employees', schema: 'PUBLIC' },
      { kind: 'view', name: 'employee_details', schema: 'PUBLIC' },
    ]);
    store.catalog.storeColumns('profile-1', 'PUBLIC', 'employees', [
      { name: 'ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
    ]);
    expect(store.listRecentFiles()[0]).toMatchObject({ filePath: 'C:\\sql\\one.sql', title: 'one.sql' });
    const page = store.catalog.queryObjects({
      connectionId: 'profile-1', schema: 'PUBLIC', prefix: 'emp', limit: 10,
    });
    expect(page.objects.map((object) => object.name)).toEqual(['employee_details', 'employees']);
    expect(store.catalog.getColumns('profile-1', 'PUBLIC', 'employees')).toHaveLength(1);
    store.catalog.invalidateConnection('profile-1');
    expect(store.catalog.queryObjects({
      connectionId: 'profile-1', schema: 'PUBLIC', prefix: '', limit: 10,
    }).objects).toHaveLength(0);
    store.close();
  });
});
