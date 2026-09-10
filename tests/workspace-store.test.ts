// @vitest-environment node

import { existsSync, rmSync } from 'node:fs';
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
});
