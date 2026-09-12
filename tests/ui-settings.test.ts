// @vitest-environment node

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UI_SETTINGS, normalizeUiSettings } from '../src/shared/defaults';
import { WorkspaceStore } from '../src/main/workspace-store';

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    if (existsSync(file)) rmSync(file, { force: true });
    if (existsSync(`${file}-shm`)) rmSync(`${file}-shm`, { force: true });
    if (existsSync(`${file}-wal`)) rmSync(`${file}-wal`, { force: true });
  }
});

describe('normalizeUiSettings', () => {
  it('keeps a valid configuration', () => {
    expect(normalizeUiSettings({ editorFontSize: 18, interfaceScale: 1.25 }))
      .toEqual({ editorFontSize: 18, interfaceScale: 1.25 });
  });

  it('falls back to defaults for a missing or broken value', () => {
    expect(normalizeUiSettings(undefined)).toEqual(DEFAULT_UI_SETTINGS);
    expect(normalizeUiSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
    expect(normalizeUiSettings('broken')).toEqual(DEFAULT_UI_SETTINGS);
    expect(normalizeUiSettings({ editorFontSize: Number.NaN, interfaceScale: 2 })).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('clamps the editor font size to the supported range and rounds fractions', () => {
    expect(normalizeUiSettings({ editorFontSize: 2, interfaceScale: 1 }).editorFontSize).toBe(11);
    expect(normalizeUiSettings({ editorFontSize: 99, interfaceScale: 1 }).editorFontSize).toBe(24);
    expect(normalizeUiSettings({ editorFontSize: 16.6, interfaceScale: 1 }).editorFontSize).toBe(17);
  });

  it('rejects unsupported interface scale steps', () => {
    expect(normalizeUiSettings({ editorFontSize: 14, interfaceScale: 1.2 }).interfaceScale).toBe(1);
    expect(normalizeUiSettings({ editorFontSize: 14, interfaceScale: 0.9 }).interfaceScale).toBe(0.9);
  });
});

describe('WorkspaceStore ui settings', () => {
  it('returns defaults before anything was saved', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const store = new WorkspaceStore(file);
    expect(store.loadUiSettings()).toEqual(DEFAULT_UI_SETTINGS);
    store.close();
  });

  it('persists and reloads ui settings independently of the workspace', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const first = new WorkspaceStore(file);
    first.saveWorkspace({ ...first.loadWorkspace(), theme: 'dark' });
    expect(first.saveUiSettings({ editorFontSize: 20, interfaceScale: 1.5 }))
      .toEqual({ editorFontSize: 20, interfaceScale: 1.5 });
    first.close();

    const second = new WorkspaceStore(file);
    expect(second.loadUiSettings()).toEqual({ editorFontSize: 20, interfaceScale: 1.5 });
    expect(second.loadWorkspace().theme).toBe('dark');
    second.close();
  });

  it('normalizes corrupted stored values', () => {
    const file = path.join(tmpdir(), `sqlexplorer-test-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const store = new WorkspaceStore(file);
    store.saveUiSettings({ editorFontSize: 500, interfaceScale: 3 as never });
    expect(store.loadUiSettings()).toEqual({ editorFontSize: 24, interfaceScale: 1 });
    store.close();
  });
});
