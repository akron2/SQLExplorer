import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import type {
  AppMetric,
  BootstrapPayload,
  CatalogAccessContext,
  CatalogConnectionState,
  CatalogListRequest,
  CatalogListResult,
  CatalogRefreshRequest,
  CatalogContextRequest,
  ConnectionMenuAction,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionTestRequest,
  DatabaseErrorInfo,
  ExecuteRequest,
  ExcelExportCancelRequest,
  ExcelExportFinishRequest,
  ExcelExportRowsRequest,
  ExcelExportStartRequest,
  FetchMoreRequest,
  FileCommand,
  LobBudgetDecision,
  LobBudgetRequest,
  LobProgress,
  LobReadRequest,
  LobSaveRequest,
  LobSaveResult,
  NewDocumentMenuResult,
  OpenSqlFilesRequest,
  OracleClientInput,
  OracleSettings,
  ReopenSqlFileRequest,
  SaveSqlFileRequest,
  SessionRequest,
  SessionState,
  SetSessionSchemaRequest,
  SqlCompletionRequest,
  SqlCompletionResult,
  TransactionRequest,
  UiSettings,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';
import { CatalogLoader } from './catalog-loader';
import { CompletionService } from './completion-service';
import { ConnectionRegistry } from './connection-registry';
import { DatabaseRuntimeManager } from './database-runtime-manager';
import { runDatabaseSelfTest } from './database-self-test';
import { DatabaseOperationError } from './db-worker-client';
import { ElectronSecretStorage } from './secret-storage';
import { ExcelExportService } from './excel-export-service';
import { SessionContextCache } from './session-context';
import { SqlFileService } from './sql-file-service';
import { WorkspaceStore } from './workspace-store';

const testUserData = process.env.SQLX_TEST_USER_DATA;
if (testUserData) app.setPath('userData', testUserData);

let catalogLoader: CatalogLoader | undefined;
let completionService: CompletionService | undefined;
let databaseRuntime: DatabaseRuntimeManager | undefined;
let excelExport: ExcelExportService | undefined;
let sessionContexts: SessionContextCache | undefined;
let workspaceStore: WorkspaceStore | undefined;
let connectionRegistry: ConnectionRegistry | undefined;
let sqlFileService: SqlFileService | undefined;
const windowsAllowedToClose = new Set<number>();
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;

interface DatabaseIpcResult<T> {
  error?: DatabaseErrorInfo;
  value?: T;
}

function projectRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function connectionConfigRoot(): string {
  const override = process.env.SQLX_CONFIG_ROOT;
  return override && path.isAbsolute(override) ? override : projectRoot();
}

function requireServices() {
  if (!databaseRuntime || !workspaceStore || !connectionRegistry || !sqlFileService
    || !catalogLoader || !completionService || !sessionContexts || !excelExport) {
    throw new Error('Application services are not initialized');
  }
  return {
    databaseRuntime, workspaceStore, connectionRegistry, sqlFileService,
    catalogLoader, completionService, sessionContexts, excelExport,
  };
}

async function profileForCatalog(connectionId: string): Promise<ConnectionProfile | undefined> {
  try {
    return await requireServices().connectionRegistry.get(connectionId);
  } catch {
    return undefined;
  }
}

async function refreshSessionContext(profile: ConnectionProfile, documentId: string): Promise<CatalogAccessContext | undefined> {
  const services = requireServices();
  try {
    const context = await services.databaseRuntime.sessionContext(profile, {
      connectionId: profile.id,
      documentId,
    });
    if (context) services.sessionContexts.setSession(profile.id, documentId, context);
    return services.sessionContexts.get(profile.id, documentId);
  } catch {
    return undefined;
  }
}

function defaultContext(connectionId: string, username: string, dialect: string, schema?: string): CatalogAccessContext {
  return {
    connectionId,
    userName: username,
    currentSchema: schema ?? (dialect === 'oracle' ? username.toUpperCase() : 'public'),
    searchPath: [],
    source: 'default',
    fetchedAt: new Date().toISOString(),
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  const rendererUrl = process.env.SQLX_RENDERER_URL;
  const trustedDevOrigin = rendererUrl ? new URL(rendererUrl).origin : undefined;
  if (senderUrl.startsWith('file://')) return;
  if (trustedDevOrigin && new URL(senderUrl).origin === trustedDevOrigin) return;
  throw new Error(`Rejected IPC sender: ${senderUrl}`);
}

function handle<TArgs extends unknown[]>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...(args as TArgs));
  });
}

function errorInfo(error: unknown): DatabaseErrorInfo {
  if (error instanceof DatabaseOperationError) return error.serialize();
  const value = error instanceof Error ? error : new Error(String(error));
  return { kind: 'unknown', message: value.message, retryable: false };
}

function databaseHandle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult>,
): void {
  handle(channel, async (event, ...args): Promise<DatabaseIpcResult<TResult>> => {
    try {
      return { value: await handler(event, ...(args as TArgs)) };
    } catch (error) {
      return { error: errorInfo(error) };
    }
  });
}

function windowFor(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

function sendFileCommand(command: FileCommand): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(IPC_CHANNELS.fileCommand, command);
}

function buildApplicationMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новый SQL', accelerator: 'CmdOrCtrl+N', click: () => sendFileCommand('new') },
        { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: () => sendFileCommand('open') },
        { type: 'separator' },
        { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => sendFileCommand('save') },
        { label: 'Сохранить как…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendFileCommand('saveAs') },
        { label: 'Сохранить все', accelerator: 'CmdOrCtrl+Alt+S', click: () => sendFileCommand('saveAll') },
        { type: 'separator' },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: () => sendFileCommand('close') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { label: 'Правка', role: 'editMenu' },
    { label: 'Вид', role: 'viewMenu' },
    { label: 'Окно', role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

function popupChoice<T>(
  window: BrowserWindow | undefined,
  entries: Array<{ enabled?: boolean; label?: string; type?: 'separator'; value?: T }>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let selected = false;
    const template: MenuItemConstructorOptions[] = entries.map((entry) => entry.type === 'separator'
      ? { type: 'separator' }
      : {
          label: entry.label,
          enabled: entry.enabled,
          click: () => {
            selected = true;
            resolve(entry.value);
          },
        });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window,
      callback: () => {
        if (!selected) resolve(undefined);
      },
    });
  });
}

function registerIpc(): void {
  handle(IPC_CHANNELS.bootstrap, (): BootstrapPayload => {
    const services = requireServices();
    const connections = services.connectionRegistry.list();
    const connectionIds = new Set(connections.map((profile) => profile.id));
    const storedWorkspace = services.workspaceStore.loadWorkspace();
    const reconcileDocument = (document: WorkspaceSnapshot['documents'][number]) => {
      if (connectionIds.has(document.connectionId ?? '')) return document;
      if (!document.filePath && !document.text && connections[0]) {
        return { ...document, connectionId: connections[0].id, dialect: connections[0].kind };
      }
      return { ...document, connectionId: null, dialect: document.connectionId ? 'sql' : document.dialect };
    };
    const documents = storedWorkspace.documents.map(reconcileDocument);
    const workspace: WorkspaceSnapshot = {
      ...storedWorkspace,
      documents,
      closedDocuments: storedWorkspace.closedDocuments.map(reconcileDocument),
      explorerConnectionId: connectionIds.has(storedWorkspace.explorerConnectionId ?? '')
        ? storedWorkspace.explorerConnectionId
        : connections[0]?.id ?? null,
    };
    return {
      connections,
      oracleClients: services.connectionRegistry.oracleClients(),
      oracleSettings: services.connectionRegistry.oracleSettings(),
      platform: process.platform,
      sessionStates: services.databaseRuntime.states(),
      uiSettings: services.workspaceStore.loadUiSettings(),
      version: app.getVersion(),
      workspace,
    };
  });

  handle(IPC_CHANNELS.saveWorkspace, (_event, snapshot: WorkspaceSnapshot) => {
    requireServices().workspaceStore.saveWorkspace(snapshot);
  });

  handle(IPC_CHANNELS.saveUiSettings, (_event, settings: UiSettings) =>
    requireServices().workspaceStore.saveUiSettings(settings));

  handle(IPC_CHANNELS.confirmAppClose, (event, allow: boolean) => {
    const window = windowFor(event);
    if (!window || !allow) return;
    windowsAllowedToClose.add(window.id);
    setImmediate(() => window.close());
  });

  handle(IPC_CHANNELS.saveConnection, async (_event, input: ConnectionProfileInput) => {
    const services = requireServices();
    const profile = await services.connectionRegistry.save(input);
    services.databaseRuntime.markProfileOutdated(profile.id, profile.profileVersion);
    services.catalogLoader.invalidateConnection(profile.id);
    services.sessionContexts.clearConnection(profile.id);
    return profile;
  });

  handle(IPC_CHANNELS.deleteConnection, async (_event, connectionId: string) => {
    const services = requireServices();
    const sessions = services.databaseRuntime.sessionsForConnection(connectionId);
    const changed = sessions.find((state) => state.transactionState === 'changed');
    if (changed) throw new Error('Нельзя удалить соединение с незавершённой транзакцией');
    const profile = services.connectionRegistry.sessionProfile(connectionId);
    await Promise.all(sessions.map((state) => services.databaseRuntime.disconnect(profile, {
      connectionId, documentId: state.documentId, force: false,
    })));
    for (const state of sessions) services.sessionContexts.clearDocument(state.documentId);
    services.connectionRegistry.delete(connectionId);
    services.catalogLoader.invalidateConnection(connectionId);
  });

  handle(IPC_CHANNELS.saveOracleSettings, (_event, settings: OracleSettings) => {
    const services = requireServices();
    const saved = services.connectionRegistry.saveOracleSettings(settings);
    for (const profile of services.connectionRegistry.list()) {
      services.databaseRuntime.markProfileOutdated(profile.id, profile.profileVersion);
    }
    return saved;
  });
  handle(IPC_CHANNELS.saveOracleClient, (_event, input: OracleClientInput) => {
    const services = requireServices();
    const saved = services.connectionRegistry.saveOracleClient(input);
    for (const profile of services.connectionRegistry.list()) {
      services.databaseRuntime.markProfileOutdated(profile.id, profile.profileVersion);
    }
    return saved;
  });
  handle(IPC_CHANNELS.deleteOracleClient, (_event, clientId: string) =>
    requireServices().connectionRegistry.deleteOracleClient(clientId));

  databaseHandle(IPC_CHANNELS.testConnection, async (_event, request: ConnectionTestRequest) => {
    const services = requireServices();
    const profile = request.profile
      ? await services.connectionRegistry.profileForTest(request.profile)
      : await services.connectionRegistry.get(request.connectionId ?? '');
    return services.databaseRuntime.testConnection(profile);
  });

  databaseHandle(IPC_CHANNELS.connect, async (_event, request: SessionRequest) => {
    const services = requireServices();
    const profile = await services.connectionRegistry.get(request.connectionId);
    const state = await services.databaseRuntime.connect(profile, request);
    await refreshSessionContext(profile, request.documentId);
    return state;
  });
  databaseHandle(IPC_CHANNELS.disconnect, async (_event, request: SessionRequest) => {
    const services = requireServices();
    const state = await services.databaseRuntime.disconnect(services.connectionRegistry.sessionProfile(request.connectionId), request);
    services.sessionContexts.clearDocument(request.documentId);
    return state;
  });
  databaseHandle(IPC_CHANNELS.reconnect, async (_event, request: SessionRequest) => {
    const services = requireServices();
    const profile = await services.connectionRegistry.get(request.connectionId);
    const state = await services.databaseRuntime.reconnect(profile, request);
    await refreshSessionContext(profile, request.documentId);
    return state;
  });
  databaseHandle(IPC_CHANNELS.execute, async (_event, request: ExecuteRequest) => {
    const services = requireServices();
    const profile = await services.connectionRegistry.get(request.connectionId);
    const page = await services.databaseRuntime.execute(profile, request);
    await refreshSessionContext(profile, request.documentId);
    return page;
  });
  databaseHandle(IPC_CHANNELS.fetchMore, async (_event, request: FetchMoreRequest) =>
    requireServices().databaseRuntime.fetchMore(request));
  databaseHandle(IPC_CHANNELS.cancel, async (_event, executionId: string) =>
    requireServices().databaseRuntime.cancel(executionId));
  databaseHandle(IPC_CHANNELS.readLob, async (_event, request: LobReadRequest) =>
    requireServices().databaseRuntime.readLob(request));
  databaseHandle(IPC_CHANNELS.saveLob, async (event, request: LobSaveRequest): Promise<LobSaveResult> => {
    const services = requireServices();
    const filePath = await services.sqlFileService.chooseLobSavePath(windowFor(event), request.suggestedName);
    if (!filePath) return { status: 'cancelled' };
    return services.databaseRuntime.saveLob(request, filePath);
  });
  databaseHandle(IPC_CHANNELS.cancelLobSave, async (_event, operationId: string) =>
    requireServices().databaseRuntime.cancelLobSave(operationId));
  databaseHandle(IPC_CHANNELS.confirmLobBudget, async (_event, decision: LobBudgetDecision) => {
    await requireServices().databaseRuntime.confirmLobBudget(decision);
  });
  databaseHandle(IPC_CHANNELS.excelStart, async (event, request: ExcelExportStartRequest) =>
    requireServices().excelExport.start(windowFor(event), request));
  databaseHandle(IPC_CHANNELS.excelRows, async (_event, request: ExcelExportRowsRequest) => {
    await requireServices().excelExport.writeRows(request);
  });
  databaseHandle(IPC_CHANNELS.excelFinish, async (_event, request: ExcelExportFinishRequest) =>
    requireServices().excelExport.finish(request));
  databaseHandle(IPC_CHANNELS.excelCancel, async (_event, request: ExcelExportCancelRequest) => {
    await requireServices().excelExport.cancel(request);
  });
  databaseHandle(IPC_CHANNELS.commit, async (_event, request: TransactionRequest) => {
    const services = requireServices();
    await services.databaseRuntime.commit(services.connectionRegistry.sessionProfile(request.connectionId), request);
  });
  databaseHandle(IPC_CHANNELS.rollback, async (_event, request: TransactionRequest) => {
    const services = requireServices();
    await services.databaseRuntime.rollback(services.connectionRegistry.sessionProfile(request.connectionId), request);
  });
  databaseHandle(IPC_CHANNELS.catalogList, async (_event, request: CatalogListRequest): Promise<CatalogListResult> => {
    const services = requireServices();
    await services.catalogLoader.ensureOverview(request.connectionId);
    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit ?? 200)));
    const offset = Math.max(0, Math.trunc(request.offset ?? 0));
    if (request.kind === 'schemas') {
      const schemas = services.catalogLoader.listSchemas(request.connectionId, request.search);
      return {
        schemas: schemas.slice(offset, offset + limit),
        total: schemas.length,
        hasMore: offset + limit < schemas.length,
      };
    }
    if (!request.schema) return { hasMore: false, objects: [], total: 0 };
    const result = await services.catalogLoader.objects(request.connectionId, request.schema, {
      prefix: request.search ?? '',
      substring: true,
      caseSensitive: false,
      kinds: request.objectKinds,
      limit,
      offset,
    });
    return {
      hasMore: result.hasMore,
      objects: result.objects,
      total: result.hasMore ? -1 : offset + result.objects.length,
    };
  });
  databaseHandle(IPC_CHANNELS.catalogRefresh, async (_event, request: CatalogRefreshRequest) => {
    const services = requireServices();
    const state = await services.catalogLoader.refresh(request);
    const context = services.catalogLoader.context(request.connectionId);
    if (context) services.sessionContexts.setCatalog(request.connectionId, context);
    return state;
  });
  databaseHandle(IPC_CHANNELS.catalogContext, async (_event, request: CatalogContextRequest) => {
    const services = requireServices();
    const cached = services.sessionContexts.get(request.connectionId, request.documentId);
    if (cached) return cached;
    await services.catalogLoader.ensureOverview(request.connectionId);
    const context = services.catalogLoader.context(request.connectionId);
    if (context) {
      services.sessionContexts.setCatalog(request.connectionId, context);
      return { ...context, connectionId: request.connectionId };
    }
    const profile = services.connectionRegistry.list().find((entry) => entry.id === request.connectionId);
    return defaultContext(request.connectionId, profile?.username ?? '', profile?.kind ?? 'sql');
  });
  databaseHandle(IPC_CHANNELS.setSessionSchema, async (_event, request: SetSessionSchemaRequest) => {
    const services = requireServices();
    let profile: ConnectionProfile | undefined;
    let publicProfile: ConnectionProfile | undefined;
    try {
      profile = await services.connectionRegistry.get(request.connectionId);
    } catch {
      const known = services.connectionRegistry.list().find((entry) => entry.id === request.connectionId);
      if (known) publicProfile = { ...known, password: '' };
    }
    const context = profile
      ? await services.databaseRuntime.setSessionSchema(profile, request).catch(() => undefined)
      : undefined;
    if (context && profile) {
      services.sessionContexts.setSession(profile.id, request.documentId, context);
      return services.sessionContexts.get(profile.id, request.documentId);
    }
    const fallbackProfile = profile ?? publicProfile;
    return defaultContext(
      request.connectionId,
      fallbackProfile?.username ?? '',
      fallbackProfile?.kind ?? 'sql',
      request.schema,
    );
  });
  databaseHandle(IPC_CHANNELS.catalogComplete, async (_event, request: SqlCompletionRequest): Promise<SqlCompletionResult> => {
    try {
      const services = requireServices();
      let fallback: CatalogAccessContext | undefined;
      const context = request.connectionId
        ? services.sessionContexts.get(request.connectionId, request.documentId)
        : undefined;
      if (request.connectionId && !context) {
        const profile = services.connectionRegistry.list().find((entry) => entry.id === request.connectionId);
        if (profile) fallback = defaultContext(profile.id, profile.username, profile.kind);
        void services.catalogLoader.ensureOverview(request.connectionId).catch(() => undefined);
      }
      return await services.completionService.complete(request, context ?? fallback);
    } catch {
      return { items: [], incomplete: false, source: 'none' };
    }
  });
  databaseHandle(IPC_CHANNELS.listTnsAliases, async (_event, configDir: string) =>
    requireServices().databaseRuntime.listTnsAliases(configDir));

  handle(IPC_CHANNELS.chooseDirectory, (event, defaultPath?: string) =>
    requireServices().sqlFileService.chooseDirectory(windowFor(event), defaultPath));
  handle(IPC_CHANNELS.openSqlFiles, (event, request?: OpenSqlFilesRequest) =>
    requireServices().sqlFileService.open(windowFor(event), request));
  handle(IPC_CHANNELS.reopenSqlFile, (_event, request: ReopenSqlFileRequest) =>
    requireServices().sqlFileService.reopen(request));
  handle(IPC_CHANNELS.saveSqlFile, (event, request: SaveSqlFileRequest) =>
    requireServices().sqlFileService.save(windowFor(event), request));
  handle(IPC_CHANNELS.getRecentSqlFiles, () => requireServices().sqlFileService.recent());

  handle(IPC_CHANNELS.showNewDocumentMenu, (event): Promise<NewDocumentMenuResult | undefined> => {
    const connections = requireServices().connectionRegistry.list();
    const entries: Array<{ label?: string; type?: 'separator'; value?: NewDocumentMenuResult }> =
      connections.map((profile) => ({
        label: `${profile.kind === 'oracle' ? 'Oracle' : 'PostgreSQL'} · ${profile.name}${profile.privilege === 'sysdba' ? ' · SYSDBA' : ''}`,
        value: { action: 'newDocument', connectionId: profile.id },
      }));
    if (entries.length === 0) {
      entries.push({ label: 'SQL без соединения', value: { action: 'newDocument', connectionId: null } });
    }
    entries.push({ type: 'separator' }, { label: 'Добавить соединение…', value: { action: 'addConnection' } });
    return popupChoice(windowFor(event), entries);
  });

  handle(IPC_CHANNELS.showConnectionMenu, (event, connectionId: string): Promise<ConnectionMenuAction | undefined> => {
    const services = requireServices();
    const state = services.databaseRuntime.sessionsForConnection(connectionId);
    const hasChangedTransactions = state.some((session) => session.transactionState === 'changed');
    return popupChoice(windowFor(event), [
      { label: 'Новая SQL-вкладка', value: 'newDocument' },
      { label: 'Проверить соединение', value: 'test' },
      { label: 'Изменить…', value: 'edit' },
      { type: 'separator' },
      { label: 'Переподключить чистые сессии', enabled: state.length > 0 && !hasChangedTransactions, value: 'reconnect' },
      { label: 'Отключить все сессии', enabled: state.length > 0 && !hasChangedTransactions, value: 'disconnect' },
      { type: 'separator' },
      { label: 'Удалить', enabled: !hasChangedTransactions, value: 'delete' },
    ]);
  });

  ipcMain.on(IPC_CHANNELS.reportMetric, (event, metric: AppMetric) => {
    const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
    if (!senderUrl.startsWith('file://') && !process.env.SQLX_RENDERER_URL) return;
    requireServices().workspaceStore.recordMetric(metric);
  });
  ipcMain.on(IPC_CHANNELS.setTitleBarTheme, (event, theme: 'light' | 'dark') => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.setTitleBarOverlay({
      color: theme === 'dark' ? '#15191f' : '#f4f6f8',
      symbolColor: theme === 'dark' ? '#e7edf3' : '#243140',
      height: 48,
    });
  });
}

function performanceQuery(): Record<string, string> | undefined {
  const argument = process.argv.find((value) => value.startsWith('--perf-documents='));
  if (!argument) return undefined;
  const documents = argument.split('=')[1];
  return { documents, payloadKb: '64', performance: '1' };
}

async function createWindow(show = true): Promise<BrowserWindow> {
  const dark = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: dark ? '#11161c' : '#f5f7f9',
    title: 'SQLExplorer',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: dark ? '#15191f' : '#f4f6f8',
      symbolColor: dark ? '#e7edf3' : '#243140',
      height: 48,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (windowsAllowedToClose.delete(window.id)) return;
    event.preventDefault();
    window.webContents.send(IPC_CHANNELS.beforeAppClose);
  });
  const query = performanceQuery();
  const rendererUrl = process.env.SQLX_RENDERER_URL;
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(path.join(__dirname, '../renderer/main_window/index.html'), query ? { query } : undefined);
  }
  if (show) window.show();
  return window;
}

async function runPackageSmokeTest(): Promise<void> {
  const services = requireServices();
  const window = await createWindow(false);
  const renderer = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const inspect = () => {
        const editor = document.querySelector('[data-testid="sql-editor"]');
        const diagnostics = globalThis.__SQLX_DIAGNOSTICS__;
        if (editor && diagnostics?.editorInstances === 1) resolve(diagnostics);
        else if (Date.now() >= deadline) reject(new Error('Renderer did not become ready'));
        else setTimeout(inspect, 50);
      };
      inspect();
    })
  `) as { documentCount: number; editorInstances: number; modelCount: number };
  const profiles = services.connectionRegistry.list();
  const oracleProfile = profiles.find((profile) => profile.id === 'oracle-local');
  const postgresProfile = profiles.find((profile) => profile.id === 'postgres-local');
  if (!oracleProfile || !postgresProfile) throw new Error('Package smoke profiles are unavailable');
  const [oracle, postgres] = await Promise.all([
    services.databaseRuntime.testConnection(await services.connectionRegistry.get(oracleProfile.id)),
    services.databaseRuntime.testConnection(await services.connectionRegistry.get(postgresProfile.id)),
  ]);
  console.log(`PACKAGE_SMOKE_OK renderer=${renderer.editorInstances} oracle=${oracle.serverVersion} postgres=${postgres.serverVersion}`);
}

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.sqlexplorer.desktop');
  Menu.setApplicationMenu(buildApplicationMenu());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'sqlexplorer.sqlite'));
  connectionRegistry = new ConnectionRegistry(
    workspaceStore,
    new ElectronSecretStorage(),
    connectionConfigRoot(),
    !app.isPackaged || Boolean(process.env.SQLX_CONFIG_ROOT),
  );
  await connectionRegistry.initialize();
  databaseRuntime = new DatabaseRuntimeManager(__dirname);
  excelExport = new ExcelExportService(databaseRuntime);
  sqlFileService = new SqlFileService(workspaceStore);
  sessionContexts = new SessionContextCache();
  catalogLoader = new CatalogLoader(workspaceStore.catalog, databaseRuntime, (connectionId) =>
    profileForCatalog(connectionId));
  completionService = new CompletionService(catalogLoader, sessionContexts);
  catalogLoader.on('state', (state: CatalogConnectionState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.catalogStateChanged, state);
    }
    if (state.phase === 'ready' && sessionContexts) {
      const context = catalogLoader?.context(state.connectionId);
      if (context) sessionContexts.setCatalog(state.connectionId, context);
    }
  });
  databaseRuntime.on('session-state', (state: SessionState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.sessionStateChanged, state);
    }
  });
  databaseRuntime.on('lob-progress', (progress: LobProgress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.lobProgress, progress);
    }
  });
  databaseRuntime.on('lob-budget', (request: LobBudgetRequest) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.lobBudget, request);
    }
  });
  registerIpc();

  if (process.argv.includes('--smoke-test')) {
    await runPackageSmokeTest();
    await databaseRuntime.close();
    databaseRuntime = undefined;
    workspaceStore.close();
    workspaceStore = undefined;
    app.exit(0);
    return;
  }
  if (process.argv.includes('--database-test')) {
    await runDatabaseSelfTest(databaseRuntime, connectionRegistry, connectionConfigRoot());
    await databaseRuntime.close();
    databaseRuntime = undefined;
    workspaceStore.close();
    workspaceStore = undefined;
    app.exit(0);
    return;
  }
  await createWindow();
}).catch((error: unknown) => {
  console.error(error);
  const automatedRun = process.argv.includes('--smoke-test')
    || process.argv.includes('--database-test');
  if (!automatedRun) {
    dialog.showErrorBox(
      'SQLExplorer: не удалось запустить приложение',
      `Приложение завершает работу из-за ошибки запуска.\n\n`
      + `${error instanceof Error ? error.message : String(error)}\n\n`
      + `Пользовательские данные: ${app.getPath('userData')}`,
    );
  }
  app.exit(1);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void shutdownAndQuit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  const windows = BrowserWindow.getAllWindows();
  if (windows.length) {
    for (const window of windows) window.webContents.send(IPC_CHANNELS.beforeAppClose);
  } else {
    void shutdownAndQuit();
  }
});

function shutdownAndQuit(): Promise<void> {
  shutdownPromise ??= (async () => {
    if (excelExport) await excelExport.close();
    excelExport = undefined;
    if (databaseRuntime) await databaseRuntime.close();
    databaseRuntime = undefined;
    workspaceStore?.close();
    workspaceStore = undefined;
    shutdownComplete = true;
    app.quit();
  })();
  return shutdownPromise;
}
