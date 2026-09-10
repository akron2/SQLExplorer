import type { DatabaseKind, PublicConnectionProfile, SqlDocument, WorkspaceSnapshot } from '../../shared/contracts';

function timestamp(): string {
  return new Date().toISOString();
}

export function activeDocument(workspace: WorkspaceSnapshot): SqlDocument {
  return workspace.documents.find((document) => document.id === workspace.activeDocumentId)
    ?? workspace.documents[0];
}

export function selectDocument(
  workspace: WorkspaceSnapshot,
  documentId: string,
): WorkspaceSnapshot {
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
      document.id === documentId
        ? { ...document, ...update, updatedAt: timestamp() }
        : document,
    ),
  };
}

export function addDocument(
  workspace: WorkspaceSnapshot,
  connection: PublicConnectionProfile,
): WorkspaceSnapshot {
  const createdAt = timestamp();
  const untitledCount = workspace.documents.filter((document) =>
    document.title.startsWith('SQL '),
  ).length;
  const document: SqlDocument = {
    id: crypto.randomUUID(),
    connectionId: connection.id,
    dialect: connection.kind,
    title: `SQL ${untitledCount + 1}`,
    text: connection.kind === 'oracle' ? 'select *\nfrom ' : 'select *\nfrom ',
    dirty: true,
    createdAt,
    updatedAt: createdAt,
    viewState: {
      cursor: { lineNumber: 2, column: 6 },
      scrollLeft: 0,
      scrollTop: 0,
    },
  };
  return {
    ...workspace,
    activeDocumentId: document.id,
    documents: [...workspace.documents, document],
  };
}

export function closeDocument(
  workspace: WorkspaceSnapshot,
  documentId: string,
  fallbackConnection: PublicConnectionProfile,
): WorkspaceSnapshot {
  const index = workspace.documents.findIndex((document) => document.id === documentId);
  if (index < 0) return workspace;
  const closing = workspace.documents[index];
  const documents = workspace.documents.filter((document) => document.id !== documentId);
  if (documents.length === 0) {
    return addDocument(
      {
        ...workspace,
        documents: [],
        activeDocumentId: '',
        closedDocuments: [closing, ...workspace.closedDocuments].slice(0, 20),
      },
      fallbackConnection,
    );
  }
  const activeDocumentId =
    workspace.activeDocumentId === documentId
      ? documents[Math.min(index, documents.length - 1)].id
      : workspace.activeDocumentId;
  return {
    ...workspace,
    activeDocumentId,
    documents,
    closedDocuments: [closing, ...workspace.closedDocuments].slice(0, 20),
  };
}

export function restoreClosedDocument(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const [restored, ...closedDocuments] = workspace.closedDocuments;
  if (!restored) return workspace;
  return {
    ...workspace,
    activeDocumentId: restored.id,
    documents: [...workspace.documents, restored],
    closedDocuments,
  };
}

export function connectionForDialect(
  connections: PublicConnectionProfile[],
  dialect: DatabaseKind,
): PublicConnectionProfile | undefined {
  return connections.find((connection) => connection.kind === dialect);
}
