import { describe, expect, it } from 'vitest';
import { createDefaultWorkspace, createPerformanceWorkspace, defaultConnections } from '../src/shared/defaults';
import {
  addDocument,
  closeDocument,
  restoreClosedDocument,
  selectDocument,
  updateDocument,
} from '../src/renderer/state/workspace';

describe('workspace state', () => {
  it('keeps the document connection when explorer selection changes', () => {
    const workspace = createDefaultWorkspace();
    const changed = { ...workspace, explorerConnectionId: 'postgres-local' };
    expect(changed.documents[0].connectionId).toBe('oracle-local');
  });

  it('adds a document for the selected connection', () => {
    const workspace = createDefaultWorkspace();
    const postgres = defaultConnections.find((connection) => connection.id === 'postgres-local')!;
    const changed = addDocument(workspace, postgres);
    expect(changed.documents).toHaveLength(4);
    expect(changed.documents.at(-1)).toMatchObject({
      connectionId: 'postgres-local',
      dialect: 'postgres',
      dirty: true,
    });
    expect(changed.activeDocumentId).toBe(changed.documents.at(-1)?.id);
  });

  it('closes and restores the active document without losing text', () => {
    const workspace = createDefaultWorkspace();
    const activeId = workspace.activeDocumentId;
    const oracle = defaultConnections[0];
    const closed = closeDocument(workspace, activeId, oracle);
    expect(closed.documents.some((document) => document.id === activeId)).toBe(false);
    const restored = restoreClosedDocument(closed);
    expect(restored.activeDocumentId).toBe(activeId);
    expect(restored.documents.at(-1)?.text).toBe(workspace.documents[0].text);
  });

  it('marks edited content without changing other documents', () => {
    const workspace = createDefaultWorkspace();
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
});
