import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CatalogColumn,
  CatalogObjectPage,
  CatalogObjectQuery,
  CatalogOverview,
  ConnectionProfile,
  ConnectionTestResult,
  DatabaseRuntimeConfiguration,
  ExecuteRequest,
  FetchMoreRequest,
  LobBudgetDecision,
  LobChunkResult,
  LobReadRequest,
  LobSaveRequest,
  LobSaveResult,
  QueryPage,
  SessionContextResult,
  SessionRequest,
  SessionState,
  SetSessionSchemaRequest,
  TransactionRequest,
} from '../shared/contracts';
import { DatabaseWorkerClient, type DatabaseWorkerEvent } from './db-worker-client';

function canonicalPath(value: string | undefined): string {
  return value ? path.resolve(value).toLocaleLowerCase() : '';
}

function runtimeConfiguration(profile: ConnectionProfile): DatabaseRuntimeConfiguration {
  if (profile.kind === 'postgres') {
    return { kind: 'postgres', runtimeKey: 'postgres' };
  }
  if (profile.driverMode !== 'thick') {
    return { kind: 'oracle', mode: 'thin', runtimeKey: 'oracle:thin' };
  }
  if (!profile.oracleClientLibDir) throw new Error('Для Thick mode не выбран Oracle Client');
  const libDir = path.resolve(profile.oracleClientLibDir);
  const configDir = profile.effectiveNetConfigDir
    ? path.resolve(profile.effectiveNetConfigDir)
    : undefined;
  const runtimeKey = `oracle:thick:${canonicalPath(libDir)}:${canonicalPath(configDir)}`;
  return { kind: 'oracle', mode: 'thick', libDir, configDir, runtimeKey };
}

export class DatabaseRuntimeManager extends EventEmitter {
  readonly #clients = new Map<string, DatabaseWorkerClient>();
  readonly #executionRuntime = new Map<string, string>();
  readonly #executionDocument = new Map<string, string>();
  readonly #documentExecution = new Map<string, string>();
  readonly #idleTimers = new Map<string, NodeJS.Timeout>();
  readonly #lobOperations = new Map<string, string>();
  readonly #profileVersions = new Map<string, number>();
  readonly #sessionStates = new Map<string, SessionState>();

  constructor(private readonly buildDirectory: string) {
    super();
  }

  states(): SessionState[] {
    return [...this.#sessionStates.values()];
  }

  async connect(profile: ConnectionProfile, request: SessionRequest): Promise<SessionState> {
    this.#rememberProfile(profile);
    await this.#disconnectDifferentRuntime(profile, request);
    return this.#callForProfile(profile, 'connect', { profile, request });
  }

  async disconnect(profile: ConnectionProfile, request: SessionRequest): Promise<SessionState> {
    this.#rememberProfile(profile);
    const executionId = this.#documentExecution.get(request.documentId);
    if (executionId) this.#forgetExecution(executionId);
    const client = this.#clientForCurrentSession(request.documentId);
    if (client) return client.call<SessionState>('disconnect', { profile, request });
    const state: SessionState = {
      connectionId: profile.id,
      documentId: request.documentId,
      profileVersion: profile.profileVersion,
      status: 'disconnected',
      transactionState: 'clean',
    };
    this.#sessionStates.set(request.documentId, state);
    this.emit('session-state', state);
    return state;
  }

  async reconnect(profile: ConnectionProfile, request: SessionRequest): Promise<SessionState> {
    this.#rememberProfile(profile);
    const current = this.#clientForCurrentSession(request.documentId);
    const target = runtimeConfiguration(profile);
    if (current && current.runtimeKey !== target.runtimeKey) {
      await current.call<SessionState>('disconnect', { profile, request });
      return this.#clientForConfiguration(target).call<SessionState>('connect', { profile, request });
    }
    return this.#clientForConfiguration(target).call<SessionState>('reconnect', { profile, request });
  }

  async execute(profile: ConnectionProfile, request: ExecuteRequest): Promise<QueryPage> {
    this.#rememberProfile(profile);
    await this.#disconnectDifferentRuntime(profile, request);
    const client = this.#clientFor(profile);
    const previousExecution = this.#documentExecution.get(request.documentId);
    if (previousExecution) this.#forgetExecution(previousExecution);
    this.#executionRuntime.set(request.executionId, client.runtimeKey);
    this.#executionDocument.set(request.executionId, request.documentId);
    this.#documentExecution.set(request.documentId, request.executionId);
    try {
      const page = await client.call<QueryPage>('execute', { profile, request });
      return page;
    } catch (error) {
      this.#forgetExecution(request.executionId);
      throw error;
    }
  }

  async fetchMore(request: FetchMoreRequest): Promise<QueryPage> {
    const client = this.#clientForExecution(request.executionId);
    return client.call<QueryPage>('fetchMore', request);
  }

  async cancel(executionId: string): Promise<boolean> {
    const client = this.#clientForExecution(executionId);
    try {
      return await client.call<boolean>('cancel', { executionId });
    } finally {
      this.#forgetExecution(executionId);
    }
  }

  async readLob(request: LobReadRequest): Promise<LobChunkResult> {
    const client = this.#clientForExecution(request.executionId);
    return client.call<LobChunkResult>('readLob', request);
  }

  async saveLob(request: LobSaveRequest, filePath: string): Promise<LobSaveResult> {
    const client = this.#clientForExecution(request.executionId);
    const operationId = randomUUID();
    this.#lobOperations.set(operationId, client.runtimeKey);
    try {
      return await client.call<LobSaveResult>('saveLob', { ...request, filePath, operationId });
    } finally {
      this.#lobOperations.delete(operationId);
    }
  }

  async cancelLobSave(operationId: string): Promise<boolean> {
    const runtimeKey = this.#lobOperations.get(operationId);
    const client = runtimeKey ? this.#clients.get(runtimeKey) : undefined;
    if (!client) return false;
    return client.call<boolean>('cancelLobSave', { operationId });
  }

  async confirmLobBudget(decision: LobBudgetDecision): Promise<void> {
    try {
      const client = this.#clientForExecution(decision.executionId);
      await client.call<void>('confirmLobBudget', decision);
    } catch {
      // The execution may already be gone; the worker side resolves by timeout.
    }
  }

  commit(profile: ConnectionProfile, request: TransactionRequest): Promise<void> {
    this.#rememberProfile(profile);
    const client = this.#clientForCurrentSession(request.documentId) ?? this.#clientFor(profile);
    return client.call<void>('commit', { profile, request });
  }

  rollback(profile: ConnectionProfile, request: TransactionRequest): Promise<void> {
    this.#rememberProfile(profile);
    const client = this.#clientForCurrentSession(request.documentId) ?? this.#clientFor(profile);
    return client.call<void>('rollback', { profile, request });
  }

  async testConnection(profile: ConnectionProfile): Promise<ConnectionTestResult> {
    const client = this.#clientFor(profile);
    try {
      return await client.call<ConnectionTestResult>('testConnection', { profile });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  async catalogOverview(profile: ConnectionProfile): Promise<CatalogOverview> {
    const client = this.#clientFor(profile);
    try {
      return await client.call<CatalogOverview>('catalogOverview', { profile });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  async countSchemaObjects(profile: ConnectionProfile, schema: string): Promise<number> {
    const client = this.#clientFor(profile);
    try {
      return await client.call<number>('countSchemaObjects', { profile, schema });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  async listObjects(profile: ConnectionProfile, query: CatalogObjectQuery): Promise<CatalogObjectPage> {
    const client = this.#clientFor(profile);
    try {
      return await client.call<CatalogObjectPage>('listObjects', { profile, query });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  async listColumns(profile: ConnectionProfile, schema: string, object: string): Promise<CatalogColumn[]> {
    const client = this.#clientFor(profile);
    try {
      return await client.call<CatalogColumn[]>('listColumns', { profile, schema, object });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  async sessionContext(
    profile: ConnectionProfile,
    request: Pick<SessionRequest, 'connectionId' | 'documentId'>,
  ): Promise<SessionContextResult | undefined> {
    const client = this.#clientForCurrentSession(request.documentId);
    if (!client) return undefined;
    return client.call<SessionContextResult | undefined>('sessionContext', { profile, request });
  }

  async setSessionSchema(
    profile: ConnectionProfile,
    request: SetSessionSchemaRequest,
  ): Promise<SessionContextResult | undefined> {
    const client = this.#clientForCurrentSession(request.documentId);
    if (!client) return undefined;
    return client.call<SessionContextResult | undefined>('setSessionSchema', { profile, request });
  }

  async listTnsAliases(configDir: string): Promise<string[]> {
    const configuration: DatabaseRuntimeConfiguration = {
      kind: 'oracle', mode: 'thin', runtimeKey: 'oracle:thin',
    };
    const client = this.#clientForConfiguration(configuration);
    try {
      return await client.call<string[]>('listTnsAliases', { configDir: path.resolve(configDir) });
    } finally {
      this.#scheduleIdleClose(client.runtimeKey);
    }
  }

  markProfileOutdated(connectionId: string, profileVersion: number): void {
    this.#profileVersions.set(connectionId, profileVersion);
    for (const [documentId, state] of this.#sessionStates) {
      if (state.connectionId !== connectionId
        || state.profileVersion === profileVersion
        || !['connecting', 'connected', 'outdated'].includes(state.status)) continue;
      const next: SessionState = { ...state, status: 'outdated' };
      this.#sessionStates.set(documentId, next);
      this.emit('session-state', next);
    }
  }

  sessionsForConnection(connectionId: string): SessionState[] {
    return this.states().filter((state) => state.connectionId === connectionId && state.status !== 'disconnected');
  }

  async close(): Promise<void> {
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    await Promise.all([...this.#clients.values()].map((client) => client.close().catch(() => undefined)));
    this.#clients.clear();
    this.#executionRuntime.clear();
    this.#executionDocument.clear();
    this.#documentExecution.clear();
    this.#lobOperations.clear();
    this.#sessionStates.clear();
    this.#profileVersions.clear();
  }

  #callForProfile<T>(
    profile: ConnectionProfile,
    method: Parameters<DatabaseWorkerClient['call']>[0],
    payload: unknown,
  ): Promise<T> {
    return this.#clientFor(profile).call<T>(method, payload);
  }

  #clientFor(profile: ConnectionProfile): DatabaseWorkerClient {
    return this.#clientForConfiguration(runtimeConfiguration(profile));
  }

  #clientForConfiguration(configuration: DatabaseRuntimeConfiguration): DatabaseWorkerClient {
    const idleTimer = this.#idleTimers.get(configuration.runtimeKey);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.#idleTimers.delete(configuration.runtimeKey);
    }
    const existing = this.#clients.get(configuration.runtimeKey);
    if (existing) return existing;
    const client = new DatabaseWorkerClient(this.buildDirectory, configuration);
    this.#clients.set(configuration.runtimeKey, client);
    client.on('worker-event', (event: DatabaseWorkerEvent) => this.#handleWorkerEvent(event));
    client.on('runtime-exit', () => this.#handleRuntimeExit(configuration.runtimeKey, client));
    return client;
  }

  #clientForExecution(executionId: string): DatabaseWorkerClient {
    const runtimeKey = this.#executionRuntime.get(executionId);
    const client = runtimeKey ? this.#clients.get(runtimeKey) : undefined;
    if (!client) throw new Error('The execution runtime is no longer available');
    return client;
  }

  #clientForCurrentSession(documentId: string): DatabaseWorkerClient | undefined {
    const state = this.#sessionStates.get(documentId);
    if (!state?.runtimeKey || ['disconnected', 'lost', 'error'].includes(state.status)) return undefined;
    return this.#clients.get(state.runtimeKey);
  }

  async #disconnectDifferentRuntime(
    profile: ConnectionProfile,
    request: Pick<SessionRequest, 'connectionId' | 'documentId' | 'force'>,
  ): Promise<void> {
    const current = this.#clientForCurrentSession(request.documentId);
    const target = runtimeConfiguration(profile);
    if (!current || current.runtimeKey === target.runtimeKey) return;
    await current.call<SessionState>('disconnect', { profile, request });
  }

  #handleWorkerEvent(event: DatabaseWorkerEvent): void {
    if (event.event === 'lob-progress') {
      this.emit('lob-progress', event.payload);
      return;
    }
    if (event.event === 'lob-budget') {
      this.emit('lob-budget', event.payload);
      return;
    }
    if (event.event !== 'session-state') return;
    const latestVersion = this.#profileVersions.get(event.payload.connectionId);
    const state = latestVersion !== undefined
      && latestVersion !== event.payload.profileVersion
      && event.payload.status === 'connected'
      ? { ...event.payload, status: 'outdated' as const }
      : event.payload;
    this.#sessionStates.set(state.documentId, state);
    this.emit('session-state', state);
    if (state.status === 'disconnected' || state.status === 'error' || state.status === 'lost') {
      this.#scheduleIdleClose(state.runtimeKey);
    }
  }

  #handleRuntimeExit(runtimeKey: string, client: DatabaseWorkerClient): void {
    const idleTimer = this.#idleTimers.get(runtimeKey);
    if (idleTimer) clearTimeout(idleTimer);
    this.#idleTimers.delete(runtimeKey);
    if (this.#clients.get(runtimeKey) === client) this.#clients.delete(runtimeKey);
    for (const [executionId, key] of this.#executionRuntime) {
      if (key === runtimeKey) this.#forgetExecution(executionId);
    }
    for (const [operationId, key] of this.#lobOperations) {
      if (key === runtimeKey) this.#lobOperations.delete(operationId);
    }
    for (const [documentId, state] of this.#sessionStates) {
      if (state.runtimeKey !== runtimeKey || state.status === 'disconnected') continue;
      const next: SessionState = {
        ...state,
        status: 'lost',
        transactionState: state.transactionState === 'changed' ? 'lost' : 'unknown',
        error: {
          kind: 'connection', retryable: true,
          message: 'Процесс соединения завершился. Следующее действие создаст его заново.',
        },
      };
      this.#sessionStates.set(documentId, next);
      this.emit('session-state', next);
    }
  }

  #scheduleIdleClose(runtimeKey: string | undefined): void {
    if (!runtimeKey || this.#idleTimers.has(runtimeKey)) return;
    const timer = setTimeout(() => {
      this.#idleTimers.delete(runtimeKey);
      const active = this.states().some((state) =>
        state.runtimeKey === runtimeKey
        && ['connecting', 'connected', 'outdated'].includes(state.status));
      const client = this.#clients.get(runtimeKey);
      if (active || !client) return;
      this.#clients.delete(runtimeKey);
      void client.close();
    }, 30_000);
    timer.unref();
    this.#idleTimers.set(runtimeKey, timer);
  }

  #rememberProfile(profile: ConnectionProfile): void {
    const current = this.#profileVersions.get(profile.id) ?? 0;
    if (profile.profileVersion > current) this.#profileVersions.set(profile.id, profile.profileVersion);
  }

  #forgetExecution(executionId: string): void {
    const documentId = this.#executionDocument.get(executionId);
    this.#executionRuntime.delete(executionId);
    this.#executionDocument.delete(executionId);
    if (documentId && this.#documentExecution.get(documentId) === executionId) {
      this.#documentExecution.delete(documentId);
    }
  }
}

export { runtimeConfiguration };
