import * as monaco from 'monaco-editor/editor/editor.api';
import type { SqlDocument } from '../../shared/contracts';

const models = new Map<string, monaco.editor.ITextModel>();

interface DiagnosticsWindow extends Window {
  __SQLX_DIAGNOSTICS__?: {
    documentCount: number;
    editorInstances: number;
    modelCount: number;
  };
}

export function updateEditorDiagnostics(editorDelta = 0): void {
  const diagnosticsWindow = window as DiagnosticsWindow;
  const current = diagnosticsWindow.__SQLX_DIAGNOSTICS__ ?? {
    documentCount: 0,
    editorInstances: 0,
    modelCount: 0,
  };
  diagnosticsWindow.__SQLX_DIAGNOSTICS__ = {
    ...current,
    editorInstances: current.editorInstances + editorDelta,
    modelCount: models.size,
  };
}

export function disposeDocumentModel(documentId: string): void {
  const model = models.get(documentId);
  if (!model) return;
  models.delete(documentId);
  model.dispose();
  updateEditorDiagnostics();
}

export function modelForDocument(document: SqlDocument): monaco.editor.ITextModel {
  const existing = models.get(document.id);
  if (existing) {
    if (existing.getValue() !== document.text) existing.setValue(document.text);
    return existing;
  }
  const model = monaco.editor.createModel(
    document.text,
    'sql',
    monaco.Uri.parse(`inmemory://sqlexplorer/${encodeURIComponent(document.id)}.sql`),
  );
  models.set(document.id, model);
  updateEditorDiagnostics();
  return model;
}
