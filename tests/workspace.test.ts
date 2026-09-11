import { describe, expect, it } from 'vitest';
import { createDefaultWorkspace, createDemoWorkspace, createPerformanceWorkspace, defaultConnections } from '../src/shared/defaults';
import {
  addDocument,
  addOpenedDocument,
  closeDocument,
  restoreClosedDocument,
  selectDocument,
  updateDocument,
} from '../src/renderer/state/workspace';

describe('workspace state', () => {
  it('keeps the document connection when explorer selection changes', () => {
    const workspace = createDemoWorkspace();
    const changed = { ...workspace, explorerConnectionId: 'postgres-local' };
    expect(changed.documents[0].connectionId).toBe('oracle-local');
  });

  it('adds a document for the selected connection', () => {
    const workspace = createDefaultWorkspace();
    const postgres = defaultConnections.find((connection) => connection.id === 'postgres-local')!;
    const changed = addDocument(workspace, postgres);
    expect(changed.documents).toHaveLength(2);
    expect(changed.documents.at(-1)).toMatchObject({
      connectionId: 'postgres-local',
      dialect: 'postgres',
      dirty: false,
    });
    expect(changed.activeDocumentId).toBe(changed.documents.at(-1)?.id);
  });

  it('closes and restores the active document without losing text', () => {
    const workspace = createDemoWorkspace();
    const activeId = workspace.activeDocumentId;
    const oracle = defaultConnections[0];
    const closed = closeDocument(workspace, activeId, oracle);
    expect(closed.documents.some((document) => document.id === activeId)).toBe(false);
    const restored = restoreClosedDocument(closed);
    expect(restored.activeDocumentId).toBe(activeId);
    expect(restored.documents.at(-1)?.text).toBe(workspace.documents[0].text);
  });

  it('does not keep a discarded draft in closed-document history', () => {
    const workspace = createDemoWorkspace();
    const discarded = workspace.documents[0];
    const closed = closeDocument(workspace, discarded.id, defaultConnections[0], false);
    expect(closed.closedDocuments.some((document) => document.id === discarded.id)).toBe(false);
  });

  it('marks edited content without changing other documents', () => {
    const workspace = createDemoWorkspace();
    const target = workspace.documents[1];
    const changed = updateDocument(workspace, target.id, { text: 'select 42;', dirty: true });
    expect(changed.documents[1].text).toBe('select 42;');
    expect(changed.documents[0]).toBe(workspace.documents[0]);
    expect(selectDocument(changed, target.id).activeDocumentId).toBe(target.id);
  });

  it.each([1, 20, 100])('creates the %i document performance corpus', (count) => {
    const workspace = createPerformanceWorkspace(count, 2);
    expect(workspace.documents).toHaveLength(count);
    expect(new Set(workspace.documents.map((document) => document.id)).size).toBe(count);
    expect(workspace.documents[0].text.length).toBeGreaterThan(2_000);
  });

  it('creates an unbound default document that can be edited without a database', () => {
    const workspace = createDefaultWorkspace();
    expect(workspace.documents).toHaveLength(1);
    expect(workspace.documents[0]).toMatchObject({
      connectionId: null,
      dialect: 'sql',
      dirty: false,
      encoding: 'utf8',
      bom: 'none',
      eol: 'lf',
    });
  });

  it('deduplicates an already opened file path', () => {
    const workspace = createDefaultWorkspace();
    const first = addOpenedDocument(workspace, undefined, {
      filePath: 'C:\\sql\\report.sql',
      title: 'report.sql',
      text: 'select 1;',
      encoding: 'windows-1251',
      bom: 'none',
      eol: 'crlf',
      diskVersion: { modifiedAtMs: 1, size: 9 },
    });
    const second = addOpenedDocument(first, undefined, {
      filePath: 'c:\\SQL\\REPORT.sql',
      title: 'REPORT.sql',
      text: 'changed on disk',
      encoding: 'utf8',
      bom: 'none',
      eol: 'lf',
      diskVersion: { modifiedAtMs: 2, size: 15 },
    }, true);
    expect(second.documents).toHaveLength(2);
    expect(second.activeDocumentId).toBe(first.activeDocumentId);
  });
});
