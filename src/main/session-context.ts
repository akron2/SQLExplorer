import type { CatalogAccessContext, SessionContextResult } from '../shared/contracts';

export interface CatalogOverviewContext {
  currentSchema: string;
  searchPath: string[];
  userName: string;
}

export class SessionContextCache {
  readonly #byConnection = new Map<string, CatalogOverviewContext>();
  readonly #byDocument = new Map<string, { connectionId: string; context: SessionContextResult }>();

  setCatalog(connectionId: string, overview: CatalogOverviewContext): void {
    this.#byConnection.set(connectionId, overview);
  }

  setSession(connectionId: string, documentId: string, context: SessionContextResult): void {
    this.#byDocument.set(documentId, { connectionId, context });
  }

  get(connectionId: string, documentId: string): CatalogAccessContext | undefined {
    const session = this.#byDocument.get(documentId);
    if (session?.connectionId === connectionId) {
      return {
        connectionId,
        userName: session.context.userName,
        currentSchema: session.context.currentSchema,
        searchPath: session.context.searchPath,
        source: 'session',
        fetchedAt: new Date().toISOString(),
      };
    }
    const base = this.#byConnection.get(connectionId);
    if (!base) return undefined;
    return {
      connectionId,
      userName: base.userName,
      currentSchema: base.currentSchema,
      searchPath: base.searchPath,
      source: 'catalog',
      fetchedAt: new Date().toISOString(),
    };
  }

  clearDocument(documentId: string): void {
    this.#byDocument.delete(documentId);
  }

  clearConnection(connectionId: string): void {
    this.#byConnection.delete(connectionId);
    for (const [documentId, value] of this.#byDocument) {
      if (value.connectionId === connectionId) this.#byDocument.delete(documentId);
    }
  }
}
