import { EventEmitter } from 'node:events';
import type {
  CatalogAccessContext,
  CatalogColumn,
  CatalogConnectionState,
  CatalogObjectKind,
  CatalogObjectPage,
  CatalogObjectQuery,
  CatalogObjectSummary,
  CatalogOverview,
  CatalogRefreshRequest,
  CatalogSchemaSummary,
  ConnectionProfile,
} from '../shared/contracts';
import type { CatalogStore } from './catalog-store';

const FULL_LOAD_THRESHOLD = 20_000;
const LOAD_PAGE_SIZE = 5_000;
const REMOTE_TIMEOUT_MS = 2_500;

export interface CatalogRuntime {
  catalogOverview(profile: ConnectionProfile): Promise<CatalogOverview>;
  countSchemaObjects(profile: ConnectionProfile, schema: string): Promise<number>;
  listColumns(profile: ConnectionProfile, schema: string, object: string): Promise<CatalogColumn[]>;
  listObjects(profile: ConnectionProfile, query: CatalogObjectQuery): Promise<CatalogObjectPage>;
}

export interface CatalogObjectsOptions {
  caseSensitive: boolean;
  kinds?: CatalogObjectKind[];
  limit: number;
  offset?: number;
  prefix: string;
  substring?: boolean;
}

export interface CatalogObjectsResult {
  hasMore: boolean;
  objects: CatalogObjectSummary[];
  source: 'cache' | 'database';
}

export interface CatalogColumnsResult {
  columns: CatalogColumn[];
  source: 'cache' | 'database';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Каталог не ответил за ${timeoutMs} мс`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function emptyState(connectionId: string, phase: CatalogConnectionState['phase'], error?: string): CatalogConnectionState {
  return {
    connectionId,
    phase,
    error,
    loadedSchemas: 0,
    totalSchemas: 0,
    updatedAt: new Date().toISOString(),
  };
}

export class CatalogLoader extends EventEmitter {
  readonly #ensured = new Map<string, number>();
  readonly #overviewPromises = new Map<string, Promise<void>>();
  readonly #phases = new Map<string, { error?: string; phase: CatalogConnectionState['phase'] }>();
  readonly #schemaPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly store: CatalogStore,
    private readonly runtime: CatalogRuntime,
    private readonly profileFor: (connectionId: string) => Promise<ConnectionProfile | undefined>,
  ) {
    super();
  }

  state(connectionId: string): CatalogConnectionState {
    const counts = this.store.counts(connectionId);
    const phase = this.#phases.get(connectionId) ?? { phase: 'unavailable' as const };
    return {
      connectionId,
      phase: phase.phase,
      error: phase.error,
      loadedSchemas: counts.loaded,
      totalSchemas: counts.total,
      updatedAt: new Date().toISOString(),
    };
  }

  context(connectionId: string): CatalogAccessContext | undefined {
    return this.store.getContext(connectionId);
  }

  async ensureOverview(connectionId: string): Promise<void> {
    const profile = await this.profileFor(connectionId);
    if (!profile) {
      if (this.#phases.get(connectionId)?.phase !== 'ready') {
        this.#setPhase(connectionId, 'error', 'Профиль соединения недоступен');
      }
      return;
    }
    if (this.#ensured.get(connectionId) === profile.profileVersion) return;
    const existing = this.#overviewPromises.get(connectionId);
    if (existing) return existing;
    const promise = this.#loadOverview(profile).finally(() => this.#overviewPromises.delete(connectionId));
    this.#overviewPromises.set(connectionId, promise);
    return promise;
  }

  listSchemas(connectionId: string, search?: string): CatalogSchemaSummary[] {
    return this.store.listSchemas(connectionId, search);
  }

  resolveSchema(connectionId: string, name: string, caseSensitive: boolean): string | undefined {
    return this.store.resolveSchemaName(connectionId, name, caseSensitive);
  }

  async ensureSchema(connectionId: string, schema: string): Promise<void> {
    const key = `${connectionId}\u0000${schema}`;
    const existing = this.#schemaPromises.get(key);
    if (existing) return existing;
    const promise = this.#loadSchema(connectionId, schema).finally(() => this.#schemaPromises.delete(key));
    this.#schemaPromises.set(key, promise);
    return promise;
  }

  async objects(
    connectionId: string,
    schema: string,
    options: CatalogObjectsOptions,
  ): Promise<CatalogObjectsResult> {
    const info = this.store.schemaInfo(connectionId, schema);
    if (info?.loaded && !info.stale) {
      const cached = this.store.queryObjects({ connectionId, schema, ...options });
      return { hasMore: cached.hasMore, objects: cached.objects, source: 'cache' };
    }
    if (info && !info.loaded && info.objectCount === 0 && !this.#schemaPromises.has(`${connectionId}\u0000${schema}`)) {
      void this.ensureSchema(connectionId, schema).catch(() => undefined);
    }
    const profile = await this.profileFor(connectionId);
    if (!profile) {
      const cached = this.store.queryObjects({ connectionId, schema, ...options });
      return { hasMore: cached.hasMore, objects: cached.objects, source: 'cache' };
    }
    try {
      const page = await withTimeout(this.runtime.listObjects(profile, {
        schema,
        prefix: options.prefix,
        substring: options.substring,
        caseSensitive: options.caseSensitive,
        kinds: options.kinds,
        limit: options.limit,
        offset: options.offset,
      }), REMOTE_TIMEOUT_MS);
      if (page.objects.length) this.store.storeObjects(connectionId, schema, page.objects);
      return { hasMore: page.hasMore, objects: page.objects, source: 'database' };
    } catch {
      const cached = this.store.queryObjects({ connectionId, schema, ...options });
      return { hasMore: cached.hasMore, objects: cached.objects, source: 'cache' };
    }
  }

  async columns(connectionId: string, schema: string, object: string): Promise<CatalogColumnsResult> {
    const cached = this.store.getColumns(connectionId, schema, object);
    if (cached.length) return { columns: cached, source: 'cache' };
    const profile = await this.profileFor(connectionId);
    if (!profile) return { columns: [], source: 'cache' };
    try {
      const columns = await withTimeout(this.runtime.listColumns(profile, schema, object), REMOTE_TIMEOUT_MS);
      if (columns.length) this.store.storeColumns(connectionId, schema, object, columns);
      return { columns, source: 'database' };
    } catch {
      return { columns: [], source: 'cache' };
    }
  }

  async refresh(request: CatalogRefreshRequest): Promise<CatalogConnectionState> {
    if (request.schema) {
      this.store.invalidateSchema(request.connectionId, request.schema);
      this.#setPhase(request.connectionId, 'loading');
      try {
        await this.ensureSchema(request.connectionId, request.schema);
        this.#setPhase(request.connectionId, 'ready');
      } catch (error) {
        this.#setPhase(request.connectionId, 'error', errorMessage(error));
      }
      return this.state(request.connectionId);
    }
    this.store.invalidateConnection(request.connectionId);
    this.#ensured.delete(request.connectionId);
    this.#overviewPromises.delete(request.connectionId);
    try {
      await this.ensureOverview(request.connectionId);
    } catch {
      // The state already carries the error.
    }
    return this.state(request.connectionId);
  }

  invalidateConnection(connectionId: string): void {
    this.store.invalidateConnection(connectionId);
    this.#ensured.delete(connectionId);
    this.#phases.delete(connectionId);
    this.emit('state', emptyState(connectionId, 'unavailable'));
  }

  async #loadOverview(profile: ConnectionProfile): Promise<void> {
    const connectionId = profile.id;
    this.#setPhase(connectionId, 'loading');
    try {
      const overview = await this.runtime.catalogOverview(profile);
      const previous = this.store.getContext(connectionId);
      this.store.syncSchemas(connectionId, overview.schemas, overview.currentSchema);
      if (!previous || previous.currentSchema !== overview.currentSchema || previous.userName !== overview.userName) {
        this.store.saveContext({
          connectionId,
          userName: overview.userName,
          currentSchema: overview.currentSchema,
          searchPath: overview.searchPath,
          source: 'catalog',
          fetchedAt: new Date().toISOString(),
        });
      }
      this.#ensured.set(connectionId, profile.profileVersion);
      this.#setPhase(connectionId, 'ready');
    } catch (error) {
      this.#setPhase(connectionId, 'error', errorMessage(error));
    }
  }

  async #loadSchema(connectionId: string, schema: string): Promise<void> {
    const info = this.store.schemaInfo(connectionId, schema);
    if (info?.loaded && !info.stale) return;
    const profile = await this.profileFor(connectionId);
    if (!profile) throw new Error('Профиль соединения недоступен');
    const count = await this.runtime.countSchemaObjects(profile, schema);
    if (count > FULL_LOAD_THRESHOLD) {
      this.store.markSchemaOnDemand(connectionId, schema, count);
      this.emit('state', this.state(connectionId));
      return;
    }
    this.store.clearSchemaObjects(connectionId, schema);
    let offset = 0;
    for (;;) {
      const page = await this.runtime.listObjects(profile, {
        schema,
        prefix: '',
        caseSensitive: true,
        limit: LOAD_PAGE_SIZE,
        offset,
      });
      if (page.objects.length) this.store.storeObjects(connectionId, schema, page.objects);
      offset += page.objects.length;
      if (!page.hasMore || page.objects.length === 0 || offset > FULL_LOAD_THRESHOLD + LOAD_PAGE_SIZE) break;
    }
    this.store.markSchemaLoaded(connectionId, schema, count);
    this.emit('state', this.state(connectionId));
  }

  #setPhase(connectionId: string, phase: CatalogConnectionState['phase'], error?: string): void {
    this.#phases.set(connectionId, { phase, error });
    this.emit('state', this.state(connectionId));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
