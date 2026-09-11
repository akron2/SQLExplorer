import type {
  AppMetric,
  BootstrapPayload,
  ConnectionProfileInput,
  ExecuteRequest,
  MetadataSnapshot,
  OpenedSqlFile,
  OracleClientDefinition,
  OracleSettings,
  PublicConnectionProfile,
  QueryColumn,
  QueryPage,
  QueryRow,
  SQLExplorerApi,
  SaveSqlFileRequest,
  SessionRequest,
  SessionState,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createDemoWorkspace, defaultConnections, defaultMetadata } from '../shared/defaults';

const workspaceKey = 'sqlexplorer.browser.workspace';
const profilesKey = 'sqlexplorer.browser.profiles';
const settingsKey = 'sqlexplorer.browser.oracle-settings';
const clientsKey = 'sqlexplorer.browser.oracle-clients';
const cancelled = new Set<string>();
const sessionStates = new Map<string, SessionState>();
const sessionListeners = new Set<(state: SessionState) => void>();
let profiles = loadProfiles();
let oracleSettings = loadJson<OracleSettings>(settingsKey) ?? { defaultNetConfigDir: '' };
let oracleClients = loadJson<OracleClientDefinition[]>(clientsKey) ?? [];

function loadJson<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : undefined;
  } catch {
    return undefined;
  }
}

function loadProfiles(): PublicConnectionProfile[] {
  return loadJson<PublicConnectionProfile[]>(profilesKey)
    ?? defaultConnections.map((profile) => ({ ...profile, credentialState: 'saved' }));
}

function browserWorkspace(): WorkspaceSnapshot {
  const saved = loadJson<WorkspaceSnapshot>(workspaceKey);
  return saved?.schemaVersion === 2 ? saved : createDemoWorkspace();
}

function persistProfiles(): void {
  localStorage.setItem(profilesKey, JSON.stringify(profiles));
}

function emitSession(state: SessionState): SessionState {
  sessionStates.set(state.documentId, state);
  for (const listener of sessionListeners) listener(state);
  return state;
}

function connectedState(request: SessionRequest): SessionState {
  const profile = profiles.find((candidate) => candidate.id === request.connectionId);
  if (!profile) throw new Error('Unknown demo connection');
  const now = new Date().toISOString();
  return emitSession({
    connectionId: profile.id,
    documentId: request.documentId,
    profileVersion: profile.profileVersion,
    status: 'connected',
    transactionState: sessionStates.get(request.documentId)?.transactionState ?? 'clean',
    connectedAt: sessionStates.get(request.documentId)?.connectedAt ?? now,
    lastActivityAt: now,
    runtimeKey: profile.kind === 'oracle' ? `oracle:${profile.driverMode ?? 'thin'}` : 'postgres',
  });
}

function oraclePage(executionId: string): QueryPage {
  const columns: QueryColumn[] = [
    { key: 'column-0', name: 'EMPLOYEE_ID', typeName: 'NUMBER(10)', nullable: false },
    { key: 'column-1', name: 'FULL_NAME', typeName: 'VARCHAR2(120)', nullable: false },
    { key: 'column-2', name: 'DEPARTMENT_NAME', typeName: 'VARCHAR2(100)', nullable: true },
    { key: 'column-3', name: 'SALARY', typeName: 'NUMBER(18,4)', nullable: true },
  ];
  const rows: QueryRow[] = [
    { index: 1, cells: ['1', 'Alex Demo', 'Engineering', '12345.6789'] },
    { index: 2, cells: ['2', 'Taylor Example', 'Engineering', '9876.5432'] },
    { index: 3, cells: ['3', 'Sam Sample', 'Analytics', null] },
  ];
  return {
    executionId, status: 'ready', columns, rows, hasMore: false, elapsedMs: 84,
    message: '3 rows fetched', transactionState: 'clean',
  };
}

function postgresPage(executionId: string): QueryPage {
  const columns: QueryColumn[] = [
    { key: 'column-0', name: 'schemaname', typeName: 'name', nullable: false },
    { key: 'column-1', name: 'tablename', typeName: 'name', nullable: false },
    { key: 'column-2', name: 'tableowner', typeName: 'name', nullable: false },
  ];
  const rows = ['departments', 'employees', 'employee_audit'].map((name, index) => ({
    index: index + 1, cells: ['public', name, 'sqlx_dev'],
  }));
  return {
    executionId, status: 'ready', columns, rows, hasMore: false, elapsedMs: 61,
    message: '3 rows fetched', transactionState: 'clean',
  };
}

async function waitForMock(executionId: string): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
  if (cancelled.delete(executionId)) throw new Error('Query cancelled');
}

function profileFromInput(input: ConnectionProfileInput, existing?: PublicConnectionProfile): PublicConnectionProfile {
  const profileVersion = existing
    ? existing.profileVersion + (JSON.stringify({ ...existing, name: '', color: '' }) === JSON.stringify({ ...input, name: '', color: '' }) ? 0 : 1)
    : 1;
  const database = input.kind === 'oracle'
    ? input.addressMode === 'tnsAlias' ? input.tnsAlias ?? ''
      : input.addressMode === 'connectString' ? input.connectString ?? ''
        : input.serviceName ?? input.database
    : input.database;
  return {
    id: existing?.id ?? input.id ?? crypto.randomUUID(),
    name: input.name,
    kind: input.kind,
    color: input.color,
    host: input.host,
    port: input.port,
    database,
    username: input.username,
    credentialState: input.password ? (input.rememberPassword ? 'saved' : 'session') : existing?.credentialState ?? 'missing',
    profileVersion,
    driverMode: input.kind === 'oracle' ? input.driverMode ?? 'thin' : undefined,
    addressMode: input.kind === 'oracle' ? input.addressMode ?? 'basic' : undefined,
    serviceName: input.serviceName,
    tnsAlias: input.tnsAlias,
    connectString: input.connectString,
    privilege: input.privilege,
    netConfigSource: input.netConfigSource,
    netConfigDir: input.netConfigDir,
    effectiveNetConfigDir: input.netConfigSource === 'profile' ? input.netConfigDir : oracleSettings.defaultNetConfigDir,
    oracleClientId: input.oracleClientId,
    oracleClientName: oracleClients.find((client) => client.id === input.oracleClientId)?.name,
  };
}

function openedFromFile(file: File): Promise<OpenedSqlFile> {
  return file.text().then((text) => ({
    filePath: file.name,
    title: file.name,
    text: text.replace(/\r\n|\r/gu, '\n'),
    encoding: 'utf8',
    bom: 'none',
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
    diskVersion: { modifiedAtMs: file.lastModified, size: file.size },
    uncertainEncoding: false,
  }));
}

export const mockApi: SQLExplorerApi = {
  bootstrap(): Promise<BootstrapPayload> {
    return Promise.resolve({
      connections: profiles,
      metadata: defaultMetadata,
      oracleClients,
      oracleSettings,
      platform: 'browser',
      sessionStates: [...sessionStates.values()],
      version: '0.1.0-browser',
      workspace: browserWorkspace(),
    });
  },
  async execute(request: ExecuteRequest): Promise<QueryPage> {
    const state = connectedState(request);
    await waitForMock(request.executionId);
    if (/raise_error|syntax_error/iu.test(request.sql)) throw new Error('Demo syntax error near line 1');
    const page = request.connectionId === 'postgres-local' ? postgresPage(request.executionId) : oraclePage(request.executionId);
    if (/^\s*(insert|update|delete|merge|begin|declare)\b/iu.test(request.sql)) {
      emitSession({ ...state, transactionState: 'changed' });
      return { ...page, transactionState: 'changed' };
    }
    return page;
  },
  async fetchMore(request) {
    await waitForMock(request.executionId);
    return { ...oraclePage(request.executionId), rows: [], hasMore: false };
  },
  cancel(executionId) {
    cancelled.add(executionId);
    return Promise.resolve(true);
  },
  connect(request) { return Promise.resolve(connectedState(request)); },
  reconnect(request) {
    if (sessionStates.get(request.documentId)?.transactionState === 'changed' && !request.force) {
      return Promise.reject(Object.assign(new Error('Сначала выполните Commit или Rollback для этой вкладки'), { kind: 'transaction' }));
    }
    return Promise.resolve(connectedState(request));
  },
  disconnect(request) {
    if (sessionStates.get(request.documentId)?.transactionState === 'changed' && !request.force) {
      return Promise.reject(Object.assign(new Error('Сначала выполните Commit или Rollback для этой вкладки'), { kind: 'transaction' }));
    }
    const profile = profiles.find((candidate) => candidate.id === request.connectionId);
    return Promise.resolve(emitSession({
      connectionId: request.connectionId,
      documentId: request.documentId,
      profileVersion: profile?.profileVersion ?? 1,
      status: 'disconnected',
      transactionState: 'clean',
    }));
  },
  commit(request) {
    const state = connectedState(request);
    emitSession({ ...state, transactionState: 'clean' });
    return Promise.resolve();
  },
  rollback(request) {
    const state = connectedState(request);
    emitSession({ ...state, transactionState: 'clean' });
    return Promise.resolve();
  },
  async refreshMetadata(connectionId: string): Promise<MetadataSnapshot> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    const metadata = defaultMetadata.find((snapshot) => snapshot.connectionId === connectionId);
    if (!metadata) throw new Error('Unknown demo connection');
    return { ...metadata, fetchedAt: new Date().toISOString(), stale: false };
  },
  reportMetric(metric: AppMetric) { console.info('[metric]', metric); },
  saveWorkspace(snapshot: WorkspaceSnapshot) {
    localStorage.setItem(workspaceKey, JSON.stringify(snapshot));
    return Promise.resolve();
  },
  setTitleBarTheme() {},
  testConnection(request) {
    const profile = request.profile
      ? profileFromInput(request.profile, request.profile.id ? profiles.find((value) => value.id === request.profile?.id) : undefined)
      : profiles.find((value) => value.id === request.connectionId);
    if (!profile) return Promise.reject(new Error('Unknown demo connection'));
    return Promise.resolve({
      elapsedMs: 42,
      serverVersion: profile.kind === 'oracle' ? 'Oracle Database 21c XE' : 'PostgreSQL 10.23',
      driverMode: profile.driverMode,
      oracleClientVersion: profile.driverMode === 'thick' ? '19.32' : undefined,
    });
  },
  saveConnection(input) {
    const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
    const saved = profileFromInput(input, existing);
    profiles = existing
      ? profiles.map((profile) => profile.id === saved.id ? saved : profile)
      : [...profiles, saved];
    persistProfiles();
    return Promise.resolve(saved);
  },
  deleteConnection(connectionId) {
    profiles = profiles.filter((profile) => profile.id !== connectionId);
    persistProfiles();
    return Promise.resolve();
  },
  chooseDirectory: () => Promise.resolve('C:\\oracle\\network\\admin'),
  confirmAppClose: () => Promise.resolve(),
  listTnsAliases: () => Promise.resolve(['ORCL', 'FINANCE', 'REPORTING']),
  saveOracleSettings(settings) {
    oracleSettings = settings;
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    return Promise.resolve(settings);
  },
  saveOracleClient(input) {
    const saved = { id: input.id ?? crypto.randomUUID(), name: input.name, libDir: input.libDir };
    oracleClients = input.id
      ? oracleClients.map((client) => client.id === input.id ? saved : client)
      : [...oracleClients, saved];
    localStorage.setItem(clientsKey, JSON.stringify(oracleClients));
    return Promise.resolve(saved);
  },
  deleteOracleClient(clientId) {
    oracleClients = oracleClients.filter((client) => client.id !== clientId);
    localStorage.setItem(clientsKey, JSON.stringify(oracleClients));
    return Promise.resolve();
  },
  showNewDocumentMenu: () => Promise.resolve(undefined),
  showConnectionMenu: () => Promise.resolve(undefined),
  onSessionStateChanged(listener) {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  },
  onBeforeAppClose: () => () => undefined,
  onFileCommand: () => () => undefined,
  openSqlFiles: () => Promise.resolve([]),
  openDroppedFiles: (files) => Promise.all(files.map(openedFromFile)),
  reopenSqlFile: () => Promise.reject(new Error('Reopen with encoding is available in the desktop app')),
  saveSqlFile(request: SaveSqlFileRequest) {
    const blob = new Blob([request.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = request.filePath ?? request.title;
    anchor.click();
    URL.revokeObjectURL(url);
    const filePath = request.filePath ?? request.title;
    return Promise.resolve({
      status: 'saved',
      file: {
        filePath,
        title: filePath.split(/[\\/]/u).at(-1) ?? request.title,
        text: request.text,
        encoding: request.encoding,
        bom: request.bom,
        eol: request.eol,
        diskVersion: { modifiedAtMs: Date.now(), size: request.text.length },
        uncertainEncoding: false,
      },
    });
  },
  getRecentSqlFiles: () => Promise.resolve([]),
};

export function getApi(): SQLExplorerApi {
  return window.sqlExplorer ?? mockApi;
}
