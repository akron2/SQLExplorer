import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AppMetric,
  BootstrapPayload,
  ConnectionMenuAction,
  ConnectionProfileInput,
  ConnectionTestRequest,
  ConnectionTestResult,
  DatabaseErrorInfo,
  ExecuteRequest,
  FetchMoreRequest,
  FileCommand,
  MetadataSnapshot,
  NewDocumentMenuResult,
  OpenedSqlFile,
  OpenSqlFilesRequest,
  OracleClientDefinition,
  OracleClientInput,
  OracleSettings,
  QueryPage,
  RecentSqlFile,
  ReopenSqlFileRequest,
  SaveSqlFileRequest,
  SaveSqlFileResult,
  SessionRequest,
  SessionState,
  SQLExplorerApi,
  TransactionRequest,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';

interface DatabaseIpcResult<T> {
  error?: DatabaseErrorInfo;
  value?: T;
}

async function invokeDatabase<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as DatabaseIpcResult<T>;
  if (result.error) {
    throw Object.assign(new Error(result.error.message), result.error, { name: 'DatabaseOperationError' });
  }
  return result.value as T;
}

const api: SQLExplorerApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapPayload>,
  cancel: (executionId: string) => invokeDatabase<boolean>(IPC_CHANNELS.cancel, executionId),
  chooseDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory, defaultPath) as Promise<string | undefined>,
  confirmAppClose: (allow: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.confirmAppClose, allow) as Promise<void>,
  commit: (request: TransactionRequest) => invokeDatabase<void>(IPC_CHANNELS.commit, request),
  connect: (request: SessionRequest) => invokeDatabase<SessionState>(IPC_CHANNELS.connect, request),
  deleteConnection: (connectionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteConnection, connectionId) as Promise<void>,
  deleteOracleClient: (clientId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteOracleClient, clientId) as Promise<void>,
  disconnect: (request: SessionRequest) => invokeDatabase<SessionState>(IPC_CHANNELS.disconnect, request),
  execute: (request: ExecuteRequest) => invokeDatabase<QueryPage>(IPC_CHANNELS.execute, request),
  fetchMore: (request: FetchMoreRequest) => invokeDatabase<QueryPage>(IPC_CHANNELS.fetchMore, request),
  getRecentSqlFiles: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getRecentSqlFiles) as Promise<RecentSqlFile[]>,
  listTnsAliases: (configDir: string) =>
    invokeDatabase<string[]>(IPC_CHANNELS.listTnsAliases, configDir),
  onFileCommand(listener: (command: FileCommand) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, command: FileCommand) => listener(command);
    ipcRenderer.on(IPC_CHANNELS.fileCommand, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.fileCommand, wrapped);
  },
  onBeforeAppClose(listener: () => void) {
    const wrapped = () => listener();
    ipcRenderer.on(IPC_CHANNELS.beforeAppClose, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.beforeAppClose, wrapped);
  },
  onSessionStateChanged(listener: (state: SessionState) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, state: SessionState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.sessionStateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.sessionStateChanged, wrapped);
  },
  openDroppedFiles(files: File[]): Promise<OpenedSqlFile[]> {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke(IPC_CHANNELS.openSqlFiles, { paths }) as Promise<OpenedSqlFile[]>;
  },
  openSqlFiles: (request?: OpenSqlFilesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.openSqlFiles, request) as Promise<OpenedSqlFile[]>,
  reconnect: (request: SessionRequest) => invokeDatabase<SessionState>(IPC_CHANNELS.reconnect, request),
  refreshMetadata: (connectionId: string) =>
    invokeDatabase<MetadataSnapshot>(IPC_CHANNELS.refreshMetadata, connectionId),
  reopenSqlFile: (request: ReopenSqlFileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.reopenSqlFile, request) as Promise<OpenedSqlFile>,
  reportMetric: (metric: AppMetric) => ipcRenderer.send(IPC_CHANNELS.reportMetric, metric),
  rollback: (request: TransactionRequest) => invokeDatabase<void>(IPC_CHANNELS.rollback, request),
  saveConnection: (profile: ConnectionProfileInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveConnection, profile),
  saveOracleClient: (client: OracleClientInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveOracleClient, client) as Promise<OracleClientDefinition>,
  saveOracleSettings: (settings: OracleSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveOracleSettings, settings) as Promise<OracleSettings>,
  saveSqlFile: (request: SaveSqlFileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSqlFile, request) as Promise<SaveSqlFileResult>,
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveWorkspace, snapshot) as Promise<void>,
  setTitleBarTheme: (theme: 'light' | 'dark') =>
    ipcRenderer.send(IPC_CHANNELS.setTitleBarTheme, theme),
  showConnectionMenu: (connectionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.showConnectionMenu, connectionId) as Promise<ConnectionMenuAction | undefined>,
  showNewDocumentMenu: () =>
    ipcRenderer.invoke(IPC_CHANNELS.showNewDocumentMenu) as Promise<NewDocumentMenuResult | undefined>,
  testConnection: (request: ConnectionTestRequest) =>
    invokeDatabase<ConnectionTestResult>(IPC_CHANNELS.testConnection, request),
};

contextBridge.exposeInMainWorld('sqlExplorer', api);
