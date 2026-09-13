import type {
  AppMetric,
  BootstrapPayload,
  CatalogAccessContext,
  CatalogColumn,
  CatalogConnectionState,
  CatalogContextRequest,
  CatalogListRequest,
  CatalogListResult,
  CatalogObjectKind,
  CatalogObjectSummary,
  CatalogRefreshRequest,
  ConnectionProfileInput,
  ExcelExportCancelRequest,
  ExcelExportFinishRequest,
  ExcelExportRowsRequest,
  ExcelExportStartRequest,
  ExcelExportStartResult,
  ExecuteRequest,
  LobBudgetDecision,
  LobCellValue,
  LobChunkResult,
  LobReadRequest,
  LobSaveRequest,
  LobSaveResult,
  LobSubtype,
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
  SetSessionSchemaRequest,
  SqlCompletionItem,
  SqlCompletionRequest,
  SqlCompletionResult,
  UiSettings,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createDemoWorkspace, defaultConnections, normalizeUiSettings } from '../shared/defaults';
import { adjustTextChunkEnd } from '../shared/lob';

const workspaceKey = 'sqlexplorer.browser.workspace';
const profilesKey = 'sqlexplorer.browser.profiles';
const settingsKey = 'sqlexplorer.browser.oracle-settings';
const clientsKey = 'sqlexplorer.browser.oracle-clients';
const uiSettingsKey = 'sqlexplorer.browser.ui-settings';
const cancelled = new Set<string>();
const sessionStates = new Map<string, SessionState>();
const sessionListeners = new Set<(state: SessionState) => void>();
let profiles = loadProfiles();
let oracleSettings = loadJson<OracleSettings>(settingsKey) ?? { defaultNetConfigDir: '' };
let oracleClients = loadJson<OracleClientDefinition[]>(clientsKey) ?? [];
let uiSettings = normalizeUiSettings(loadJson<UiSettings>(uiSettingsKey));

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
  return saved?.schemaVersion === 3 ? saved : createDemoWorkspace();
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

interface DemoLob {
  data: string;
  sizeUnit: 'bytes' | 'chars';
  subtype: LobSubtype;
}

const demoLobs = new Map<string, DemoLob>();

function demoLobKey(executionId: string, rowIndex: number, columnIndex: number): string {
  return `${executionId}:${rowIndex}:${columnIndex}`;
}

function demoClob(executionId: string, rowIndex: number, columnIndex: number): LobCellValue {
  const data = `Демонстрационный CLOB строки ${rowIndex}.\n`
    + 'строка данных SQLExplorer '.repeat(1200);
  demoLobs.set(demoLobKey(executionId, rowIndex, columnIndex), {
    data, sizeUnit: 'chars', subtype: 'CLOB',
  });
  return { kind: 'lob', subtype: 'CLOB', size: data.length, sizeUnit: 'chars', available: true };
}

function oraclePage(executionId: string): QueryPage {
  const columns: QueryColumn[] = [
    { key: 'column-0', name: 'EMPLOYEE_ID', typeName: 'NUMBER(10)', nullable: false },
    { key: 'column-1', name: 'FULL_NAME', typeName: 'VARCHAR2(120)', nullable: false },
    { key: 'column-2', name: 'DEPARTMENT_NAME', typeName: 'VARCHAR2(100)', nullable: true },
    { key: 'column-3', name: 'SALARY', typeName: 'NUMBER(18,4)', nullable: true },
    { key: 'column-4', name: 'NOTES', typeName: 'CLOB', nullable: true },
  ];
  const rows: QueryRow[] = [
    { index: 1, cells: ['1', 'Alex Demo', 'Engineering', '12345.6789', demoClob(executionId, 1, 4)] },
    { index: 2, cells: ['2', 'Taylor Example', 'Engineering', '9876.5432', demoClob(executionId, 2, 4)] },
    { index: 3, cells: ['3', 'Sam Sample', 'Analytics', null, null] },
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

interface DemoCatalog {
  columns: Record<string, CatalogColumn[]>;
  objects: Record<string, CatalogObjectSummary[]>;
  schemas: Array<{ isDefault: boolean; name: string }>;
}

const demoCatalogs: Record<string, DemoCatalog> = {
  'oracle-local': {
    schemas: [
      { name: 'SQLX', isDefault: true },
      { name: 'PUBLIC', isDefault: false },
      { name: 'SYS', isDefault: false },
    ],
    objects: {
      SQLX: [
        { kind: 'table', schema: 'SQLX', name: 'EMPLOYEES' },
        { kind: 'table', schema: 'SQLX', name: 'DEPARTMENTS' },
        { kind: 'view', schema: 'SQLX', name: 'EMPLOYEE_DETAILS' },
        { kind: 'package', schema: 'SQLX', name: 'DEMO_PKG' },
        { kind: 'synonym', schema: 'SQLX', name: 'STAFF' },
        { kind: 'sequence', schema: 'SQLX', name: 'EMPLOYEE_ID_SEQ' },
      ],
      PUBLIC: [{ kind: 'synonym', schema: 'PUBLIC', name: 'DUAL' }],
      SYS: [
        { kind: 'view', schema: 'SYS', name: 'USER_OBJECTS' },
        { kind: 'view', schema: 'SYS', name: 'USER_TABLES' },
      ],
    },
    columns: {
      'SQLX.EMPLOYEES': [
        { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
        { name: 'DEPARTMENT_ID', dataType: 'NUMBER(10)', nullable: true, position: 2 },
        { name: 'FULL_NAME', dataType: 'VARCHAR2(120)', nullable: false, position: 3 },
        { name: 'SALARY', dataType: 'NUMBER(18,4)', nullable: true, position: 4 },
        { name: 'HIRED_AT', dataType: 'TIMESTAMP', nullable: true, position: 5 },
        { name: 'NOTES', dataType: 'CLOB', nullable: true, position: 6 },
      ],
      'SQLX.DEPARTMENTS': [
        { name: 'DEPARTMENT_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
        { name: 'DEPARTMENT_NAME', dataType: 'VARCHAR2(100)', nullable: false, position: 2 },
      ],
      'SQLX.EMPLOYEE_DETAILS': [
        { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
        { name: 'FULL_NAME', dataType: 'VARCHAR2(120)', nullable: false, position: 2 },
        { name: 'DEPARTMENT_NAME', dataType: 'VARCHAR2(100)', nullable: true, position: 3 },
      ],
    },
  },
  'postgres-local': {
    schemas: [{ name: 'public', isDefault: true }],
    objects: {
      public: [
        { kind: 'table', schema: 'public', name: 'departments' },
        { kind: 'table', schema: 'public', name: 'employees' },
        { kind: 'table', schema: 'public', name: 'employee_audit' },
        { kind: 'view', schema: 'public', name: 'employee_details' },
      ],
    },
    columns: {
      'public.employees': [
        { name: 'employee_id', dataType: 'integer', nullable: false, position: 1 },
        { name: 'department_id', dataType: 'integer', nullable: true, position: 2 },
        { name: 'full_name', dataType: 'text', nullable: false, position: 3 },
        { name: 'salary', dataType: 'numeric(18,4)', nullable: true, position: 4 },
      ],
    },
  },
};

const mockKeywords = [
  'select', 'from', 'where', 'join', 'left join', 'group by', 'order by', 'having',
  'insert into', 'update', 'delete from', 'commit', 'rollback', 'begin', 'declare', 'with',
];

const catalogListeners = new Set<(state: CatalogConnectionState) => void>();
const documentContexts = new Map<string, CatalogAccessContext>();

function defaultMockContext(connectionId: string): CatalogAccessContext {
  const profile = profiles.find((candidate) => candidate.id === connectionId);
  const catalog = demoCatalogs[connectionId];
  const schema = catalog?.schemas.find((entry) => entry.isDefault)?.name
    ?? (profile?.kind === 'oracle' ? profile.username.toUpperCase() : 'public');
  return {
    connectionId,
    userName: profile?.username ?? '',
    currentSchema: schema,
    searchPath: profile?.kind === 'postgres' ? ['"$user"', 'public'] : [],
    source: 'default',
    fetchedAt: new Date().toISOString(),
  };
}

function mockCatalogState(connectionId: string): CatalogConnectionState {
  const catalog = demoCatalogs[connectionId];
  const total = catalog?.schemas.length ?? 0;
  return {
    connectionId,
    phase: catalog ? 'ready' : 'error',
    error: catalog ? undefined : 'Демо-каталог недоступен',
    loadedSchemas: catalog ? catalog.schemas.length : 0,
    totalSchemas: total,
    updatedAt: new Date().toISOString(),
  };
}

function emitMockCatalogState(connectionId: string): void {
  const state = mockCatalogState(connectionId);
  for (const listener of catalogListeners) listener(state);
}

function mockCatalogList(request: CatalogListRequest): CatalogListResult {
  const catalog = demoCatalogs[request.connectionId];
  if (!catalog) return { hasMore: false, objects: [], schemas: [], total: 0 };
  const search = (request.search ?? '').toLocaleLowerCase();
  const offset = Math.max(0, request.offset ?? 0);
  const limit = Math.max(1, Math.min(500, request.limit ?? 200));
  if (request.kind === 'schemas') {
    const schemas = catalog.schemas
      .filter((schema) => !search || schema.name.toLocaleLowerCase().includes(search))
      .map((schema) => ({
        name: schema.name,
        isDefault: schema.isDefault,
        objectCount: (catalog.objects[schema.name] ?? []).length,
        loaded: true,
        stale: false,
      }));
    return {
      schemas: schemas.slice(offset, offset + limit),
      total: schemas.length,
      hasMore: offset + limit < schemas.length,
    };
  }
  const schema = request.schema ?? '';
  const kinds = request.objectKinds?.length ? new Set<CatalogObjectKind>(request.objectKinds) : undefined;
  const objects = (catalog.objects[schema] ?? [])
    .filter((object) => (!search || object.name.toLocaleLowerCase().includes(search))
      && (!kinds || kinds.has(object.kind)));
  return {
    objects: objects.slice(offset, offset + limit),
    total: objects.length,
    hasMore: offset + limit < objects.length,
  };
}

function mockCatalogComplete(request: SqlCompletionRequest): SqlCompletionResult {
  const text = request.textWindow.slice(0, request.cursorOffset);
  const tail = /(?:(?:"([^"]*)"|([A-Za-z_][A-Za-z0-9_$#]*))\s*\.\s*)?(?:"([^"]*)"|([A-Za-z_][A-Za-z0-9_$#]*))?$/u.exec(text);
  const qualifier = tail?.[1] ?? tail?.[2];
  const prefix = tail?.[3] ?? tail?.[4] ?? '';
  const replaceStart = request.cursorOffset - prefix.length;
  const catalog = request.connectionId ? demoCatalogs[request.connectionId] : undefined;
  const context = request.connectionId
    ? documentContexts.get(request.documentId) ?? defaultMockContext(request.connectionId)
    : undefined;
  const items: SqlCompletionItem[] = [];
  const lowerPrefix = prefix.toLocaleLowerCase();
  const add = (item: SqlCompletionItem) => {
    if (items.length < 200) items.push(item);
  };
  if (catalog && context) {
    const matches = (name: string) => !lowerPrefix || name.toLocaleLowerCase().startsWith(lowerPrefix);
    if (qualifier) {
      const lower = qualifier.toLocaleLowerCase();
      const schema = catalog.schemas.find((entry) => entry.name.toLocaleLowerCase() === lower);
      const object = Object.values(catalog.objects).flat()
        .find((entry) => entry.name.toLocaleLowerCase() === lower);
      if (schema) {
        for (const entry of (catalog.objects[schema.name] ?? []).filter((value) => matches(value.name))) {
          add({
            text: entry.name, kind: entry.kind, replaceStart, replaceEnd: request.cursorOffset,
            detail: `${entry.kind} · ${entry.schema}`, sortText: `1-${entry.name.toLocaleLowerCase()}`,
          });
        }
      } else if (object) {
        for (const column of (catalog.columns[`${object.schema}.${object.name}`] ?? []).filter((value) => matches(value.name))) {
          add({
            text: column.name, kind: 'column', replaceStart, replaceEnd: request.cursorOffset,
            detail: `${column.dataType} · ${object.name}`,
            sortText: `0-${column.position.toString().padStart(5, '0')}-${column.name}`,
          });
        }
      }
    } else {
      const seen = new Set<string>();
      for (const entry of (catalog.objects[context.currentSchema] ?? []).filter((value) => matches(value.name))) {
        seen.add(entry.name.toLocaleLowerCase());
        add({
          text: entry.name, kind: entry.kind, replaceStart, replaceEnd: request.cursorOffset,
          detail: `${entry.kind} · ${entry.schema}`, sortText: `1-${entry.name.toLocaleLowerCase()}`,
        });
      }
      for (const entry of (catalog.objects.PUBLIC ?? []).filter((value) => matches(value.name))) {
        if (seen.has(entry.name.toLocaleLowerCase())) continue;
        add({
          text: entry.name, kind: entry.kind, replaceStart, replaceEnd: request.cursorOffset,
          detail: `${entry.kind} · ${entry.schema}`, sortText: `2-${entry.name.toLocaleLowerCase()}`,
        });
      }
    }
  }
  for (const keyword of mockKeywords) {
    if (lowerPrefix && !keyword.startsWith(lowerPrefix)) continue;
    add({
      text: keyword, kind: 'keyword', replaceStart, replaceEnd: request.cursorOffset,
      sortText: `9-${keyword}`,
    });
  }
  return { items, incomplete: false, source: catalog ? 'cache' : 'none' };
}

function mockSetSessionSchema(request: SetSessionSchemaRequest): CatalogAccessContext {
  const profile = profiles.find((candidate) => candidate.id === request.connectionId);
  const context: CatalogAccessContext = {
    connectionId: request.connectionId,
    userName: profile?.username ?? '',
    currentSchema: request.schema,
    searchPath: profile?.kind === 'postgres' ? [request.schema] : [],
    source: 'session',
    fetchedAt: new Date().toISOString(),
  };
  documentContexts.set(request.documentId, context);
  return context;
}

export const mockApi: SQLExplorerApi = {
  bootstrap(): Promise<BootstrapPayload> {
    return Promise.resolve({
      connections: profiles,
      oracleClients,
      oracleSettings,
      platform: 'browser',
      sessionStates: [...sessionStates.values()],
      uiSettings,
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
  cancelLobSave: () => Promise.resolve(false),
  cancelExcelExport: (_request: ExcelExportCancelRequest) => Promise.resolve(),
  confirmLobBudget: (_request: LobBudgetDecision) => Promise.resolve(),
  finishExcelExport: (request: ExcelExportFinishRequest) => Promise.resolve({
    filePath: 'browser-demo-result.xlsx',
    lobFiles: 0,
    rows: request.totalRows,
    warnings: [],
  }),
  startExcelExport: (request: ExcelExportStartRequest): Promise<ExcelExportStartResult> => Promise.resolve({
    status: 'started',
    sessionId: crypto.randomUUID(),
    targetPath: request.suggestedName,
    lobDirectory: `${request.suggestedName}.lobs`,
  }),
  writeExcelRows: (_request: ExcelExportRowsRequest) => Promise.resolve(),
  onLobBudgetRequest: () => () => undefined,
  onLobProgress: () => () => undefined,
  readLob(request: LobReadRequest): Promise<LobChunkResult> {
    const entry = demoLobs.get(demoLobKey(request.executionId, request.rowIndex, request.columnIndex));
    if (!entry) return Promise.reject(new Error('Значение больше недоступно'));
    const end = adjustTextChunkEnd(entry.data, Math.min(entry.data.length, request.offset + Math.max(1, request.length)));
    const chunk = entry.data.slice(request.offset, end);
    return Promise.resolve({
      data: chunk,
      encoding: 'utf8',
      eof: request.offset + chunk.length >= entry.data.length,
      nextOffset: request.offset + chunk.length,
      offset: request.offset,
      size: entry.data.length,
      sizeUnit: entry.sizeUnit,
      subtype: entry.subtype,
    });
  },
  saveLob(request: LobSaveRequest): Promise<LobSaveResult> {
    const entry = demoLobs.get(demoLobKey(request.executionId, request.rowIndex, request.columnIndex));
    if (!entry) return Promise.resolve({ status: 'unavailable' });
    const blob = new Blob([entry.data], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = request.suggestedName;
    anchor.click();
    URL.revokeObjectURL(url);
    return Promise.resolve({
      status: 'saved',
      filePath: request.suggestedName,
      bytes: new TextEncoder().encode(entry.data).byteLength,
    });
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
  catalogComplete(request: SqlCompletionRequest) {
    return Promise.resolve(mockCatalogComplete(request));
  },
  catalogContext(request: CatalogContextRequest) {
    const context = documentContexts.get(request.documentId);
    if (context?.connectionId === request.connectionId) return Promise.resolve(context);
    if (!demoCatalogs[request.connectionId]) return Promise.reject(new Error('Unknown demo connection'));
    return Promise.resolve(defaultMockContext(request.connectionId));
  },
  catalogList(request: CatalogListRequest) {
    return Promise.resolve(mockCatalogList(request));
  },
  async catalogRefresh(request: CatalogRefreshRequest): Promise<CatalogConnectionState> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 60));
    emitMockCatalogState(request.connectionId);
    return mockCatalogState(request.connectionId);
  },
  setSessionSchema(request: SetSessionSchemaRequest) {
    return Promise.resolve(mockSetSessionSchema(request));
  },
  onCatalogStateChanged(listener) {
    catalogListeners.add(listener);
    return () => catalogListeners.delete(listener);
  },
  reportMetric(metric: AppMetric) { console.info('[metric]', metric); },
  saveWorkspace(snapshot: WorkspaceSnapshot) {
    localStorage.setItem(workspaceKey, JSON.stringify(snapshot));
    return Promise.resolve();
  },
  saveUiSettings(settings) {
    uiSettings = normalizeUiSettings(settings);
    localStorage.setItem(uiSettingsKey, JSON.stringify(uiSettings));
    return Promise.resolve(uiSettings);
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
