import type { PublicConnectionProfile, SqlDocument, WorkspaceSnapshot } from '../../shared/contracts';

function timestamp(): string {
  return new Date().toISOString();
}

export function activeDocument(workspace: WorkspaceSnapshot): SqlDocument {
  return workspace.documents.find((document) => document.id === workspace.activeDocumentId)
    ?? workspace.documents[0];
}

export function selectDocument(workspace: WorkspaceSnapshot, documentId: string): WorkspaceSnapshot {
  if (!workspace.documents.some((document) => document.id === documentId)) return workspace;
  return { ...workspace, activeDocumentId: documentId };
}

export function updateDocument(
  workspace: WorkspaceSnapshot,
  documentId: string,
  update: Partial<SqlDocument>,
): WorkspaceSnapshot {
  return {
    ...workspace,
    documents: workspace.documents.map((document) =>
      document.id === documentId ? { ...document, ...update, updatedAt: timestamp() } : document),
  };
}

export function addDocument(
  workspace: WorkspaceSnapshot,
  connection?: PublicConnectionProfile,
  initial?: Partial<SqlDocument>,
): WorkspaceSnapshot {
  const createdAt = timestamp();
  const untitledCount = workspace.documents.filter((document) => /^SQL \d+$/u.test(document.title)).length;
  const document: SqlDocument = {
    id: crypto.randomUUID(), connectionId: connection?.id ?? null, dialect: connection?.kind ?? 'sql',
    title: `SQL ${untitledCount + 1}`, text: '', dirty: false, createdAt, updatedAt: createdAt,
    encoding: 'utf8', bom: 'none', eol: 'lf',
    viewState: { cursor: { lineNumber: 1, column: 1 }, scrollLeft: 0, scrollTop: 0 },
    ...initial,
  };
  return { ...workspace, activeDocumentId: document.id, documents: [...workspace.documents, document] };
}

export function addOpenedDocument(
  workspace: WorkspaceSnapshot,
  connection: PublicConnectionProfile | undefined,
  initial: Pick<SqlDocument, 'bom' | 'diskVersion' | 'encoding' | 'eol' | 'filePath' | 'text' | 'title'>,
  caseInsensitivePaths = false,
): WorkspaceSnapshot {
  const normalize = (value: string | undefined) => caseInsensitivePaths ? value?.toLocaleLowerCase() : value;
  const normalized = normalize(initial.filePath);
  const existing = workspace.documents.find((document) => normalize(document.filePath) === normalized);
  if (existing) return selectDocument(workspace, existing.id);
  return addDocument(workspace, connection, { ...initial, dirty: false });
}

export function closeDocument(
  workspace: WorkspaceSnapshot,
  documentId: string,
  fallbackConnection?: PublicConnectionProfile,
  rememberClosed = true,
): WorkspaceSnapshot {
  const index = workspace.documents.findIndex((document) => document.id === documentId);
  if (index < 0) return workspace;
  const closing = workspace.documents[index];
  const documents = workspace.documents.filter((document) => document.id !== documentId);
  const closedDocuments = rememberClosed
    ? [closing, ...workspace.closedDocuments].slice(0, 20)
    : workspace.closedDocuments;
  if (documents.length === 0) {
    return addDocument({
      ...workspace,
      documents: [],
      activeDocumentId: '',
      closedDocuments,
    }, fallbackConnection, { dirty: false });
  }
  const activeDocumentId = workspace.activeDocumentId === documentId
    ? documents[Math.min(index, documents.length - 1)].id
    : workspace.activeDocumentId;
  return {
    ...workspace,
    activeDocumentId,
    documents,
    closedDocuments,
  };
}

export function restoreClosedDocument(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const [restored, ...closedDocuments] = workspace.closedDocuments;
  if (!restored) return workspace;
  return {
    ...workspace, activeDocumentId: restored.id,
    documents: [...workspace.documents, restored], closedDocuments,
  };
}
