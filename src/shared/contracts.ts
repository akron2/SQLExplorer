export type DatabaseKind = 'oracle' | 'postgres';
export type SqlDialect = DatabaseKind | 'sql';
export type ThemePreference = 'light' | 'dark' | 'system';
export type OracleDriverMode = 'thin' | 'thick';
export type OracleAddressMode = 'basic' | 'tnsAlias' | 'connectString';
export type OraclePrivilege = 'normal' | 'sysdba';
export type OracleNetConfigSource = 'default' | 'profile';
export type CredentialState = 'missing' | 'saved' | 'session';
export type SessionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'lost'
  | 'outdated'
  | 'error';
export type TransactionState = 'clean' | 'changed' | 'unknown' | 'lost';
export type ExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'fetching'
  | 'ready'
  | 'cancel-requested'
  | 'cancelled'
  | 'error';
export type TextFileBom = 'none' | 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be';
export type TextFileEol = 'lf' | 'crlf' | 'cr';
export type DatabaseErrorKind =
  | 'authentication'
  | 'cancelled'
  | 'configuration'
  | 'connection'
  | 'sql'
  | 'transaction'
  | 'unknown';

export interface CursorPosition {
  column: number;
  lineNumber: number;
}

export interface EditorViewState {
  cursor: CursorPosition;
  scrollLeft: number;
  scrollTop: number;
}

export interface DiskFileVersion {
  modifiedAtMs: number;
  sha256?: string;
  size: number;
}

export interface SqlDocument {
  bom: TextFileBom;
  connectionId: string | null;
  createdAt: string;
  dialect: SqlDialect;
  dirty: boolean;
  diskVersion?: DiskFileVersion;
  encoding: string;
  eol: TextFileEol;
  filePath?: string;
  id: string;
  text: string;
  title: string;
  updatedAt: string;
  viewState?: EditorViewState;
}

export interface WorkspaceSnapshot {
  activeDocumentId: string;
  closedDocuments: SqlDocument[];
  documents: SqlDocument[];
  explorerConnectionId: string | null;
  explorerVisible: boolean;
  resultPanelHeight: number;
  schemaVersion: 2;
  theme: ThemePreference;
}

export interface PublicConnectionProfile {
  addressMode?: OracleAddressMode;
  color: string;
  connectString?: string;
  credentialState: CredentialState;
  database: string;
  driverMode?: OracleDriverMode;
  effectiveNetConfigDir?: string;
  host: string;
  id: string;
  kind: DatabaseKind;
  name: string;
  netConfigDir?: string;
  netConfigSource?: OracleNetConfigSource;
  oracleClientId?: string;
  oracleClientName?: string;
  port: number;
  privilege?: OraclePrivilege;
  profileVersion: number;
  serviceName?: string;
  tnsAlias?: string;
  username: string;
}

export interface ConnectionProfile extends PublicConnectionProfile {
  oracleClientLibDir?: string;
  password: string;
}

export interface ConnectionProfileInput {
  addressMode?: OracleAddressMode;
  clearPassword?: boolean;
  color: string;
  connectString?: string;
  database: string;
  driverMode?: OracleDriverMode;
  host: string;
  id?: string;
  kind: DatabaseKind;
  name: string;
  netConfigDir?: string;
  netConfigSource?: OracleNetConfigSource;
  oracleClientId?: string;
  password?: string;
  port: number;
  privilege?: OraclePrivilege;
  rememberPassword: boolean;
  serviceName?: string;
  tnsAlias?: string;
  username: string;
}

export interface OracleClientDefinition {
  id: string;
  libDir: string;
  name: string;
}

export interface OracleClientInput {
  id?: string;
  libDir: string;
  name: string;
}

export interface OracleSettings {
  defaultNetConfigDir: string;
}

export interface ConnectionTestRequest {
  connectionId?: string;
  profile?: ConnectionProfileInput;
}

export interface ConnectionTestResult {
  driverMode?: OracleDriverMode;
  elapsedMs: number;
  oracleClientVersion?: string;
  serverVersion: string;
}

export interface SessionRequest {
  connectionId: string;
  documentId: string;
  force?: boolean;
}

export interface SessionState {
  connectedAt?: string;
  connectionId: string;
  documentId: string;
  error?: DatabaseErrorInfo;
  lastActivityAt?: string;
  profileVersion: number;
  runtimeKey?: string;
  status: SessionStatus;
  transactionState: TransactionState;
}

export interface DatabaseErrorInfo {
  code?: string;
  kind: DatabaseErrorKind;
  message: string;
  retryable: boolean;
}

export interface MetadataColumn {
  dataType: string;
  name: string;
  nullable: boolean;
  position: number;
}

export interface MetadataObject {
  columns?: MetadataColumn[];
  kind: 'table' | 'view' | 'package' | 'sequence' | 'synonym' | 'function';
  name: string;
  schema: string;
}

export interface MetadataSnapshot {
  connectionId: string;
  fetchedAt: string;
  objects: MetadataObject[];
  schema: string;
  stale?: boolean;
}

export type CellValue = boolean | number | string | null;

export interface QueryColumn {
  key: string;
  name: string;
  nullable: boolean;
  typeName: string;
}

export interface QueryRow {
  cells: CellValue[];
  index: number;
}

export interface QueryPage {
  columns: QueryColumn[];
  elapsedMs: number;
  executionId: string;
  hasMore: boolean;
  message: string;
  rows: QueryRow[];
  rowsAffected?: number;
  status: Extract<ExecutionStatus, 'ready' | 'cancelled'>;
  transactionState: TransactionState;
}

export interface ExecuteRequest {
  connectionId: string;
  documentId: string;
  executionId: string;
  pageSize: number;
  parameters?: Record<string, CellValue>;
  sql: string;
}

export interface FetchMoreRequest {
  executionId: string;
  pageSize: number;
}

export interface TransactionRequest {
  connectionId: string;
  documentId: string;
}

export interface OpenSqlFilesRequest {
  paths?: string[];
}

export interface OpenedSqlFile {
  bom: TextFileBom;
  diskVersion: DiskFileVersion;
  encoding: string;
  eol: TextFileEol;
  filePath: string;
  text: string;
  title: string;
  uncertainEncoding: boolean;
}

export interface ReopenSqlFileRequest {
  encoding: string;
  filePath: string;
}

export interface SaveSqlFileRequest {
  bom: TextFileBom;
  diskVersion?: DiskFileVersion;
  encoding: string;
  eol: TextFileEol;
  filePath?: string;
  force?: boolean;
  saveAs?: boolean;
  text: string;
  title: string;
}

export type SaveSqlFileResult =
  | { status: 'cancelled' }
  | { currentVersion: DiskFileVersion; status: 'conflict' }
  | { file: OpenedSqlFile; status: 'saved' };

export interface RecentSqlFile {
  filePath: string;
  openedAt: string;
  title: string;
}

export type FileCommand = 'new' | 'open' | 'save' | 'saveAs' | 'saveAll' | 'close';
export type NewDocumentMenuResult = { action: 'addConnection' } | {
  action: 'newDocument';
  connectionId: string | null;
};
export type ConnectionMenuAction =
  | 'newDocument'
  | 'test'
  | 'edit'
  | 'reconnect'
  | 'disconnect'
  | 'delete';

export interface BootstrapPayload {
  connections: PublicConnectionProfile[];
  metadata: MetadataSnapshot[];
  oracleClients: OracleClientDefinition[];
  oracleSettings: OracleSettings;
  platform: NodeJS.Platform | 'browser';
  sessionStates: SessionState[];
  version: string;
  workspace: WorkspaceSnapshot;
}

export interface AppMetric {
  detail?: Record<string, number | string>;
  durationMs: number;
  name: string;
  recordedAt: string;
}

export interface SQLExplorerApi {
  bootstrap(): Promise<BootstrapPayload>;
  cancel(executionId: string): Promise<boolean>;
  chooseDirectory(defaultPath?: string): Promise<string | undefined>;
  commit(request: TransactionRequest): Promise<void>;
  connect(request: SessionRequest): Promise<SessionState>;
  deleteConnection(connectionId: string): Promise<void>;
  deleteOracleClient(clientId: string): Promise<void>;
  disconnect(request: SessionRequest): Promise<SessionState>;
  execute(request: ExecuteRequest): Promise<QueryPage>;
  fetchMore(request: FetchMoreRequest): Promise<QueryPage>;
  getRecentSqlFiles(): Promise<RecentSqlFile[]>;
  confirmAppClose(allow: boolean): Promise<void>;
  onBeforeAppClose(listener: () => void): () => void;
  listTnsAliases(configDir: string): Promise<string[]>;
  onFileCommand(listener: (command: FileCommand) => void): () => void;
  onSessionStateChanged(listener: (state: SessionState) => void): () => void;
  openDroppedFiles(files: File[]): Promise<OpenedSqlFile[]>;
  openSqlFiles(request?: OpenSqlFilesRequest): Promise<OpenedSqlFile[]>;
  reconnect(request: SessionRequest): Promise<SessionState>;
  refreshMetadata(connectionId: string): Promise<MetadataSnapshot>;
  reopenSqlFile(request: ReopenSqlFileRequest): Promise<OpenedSqlFile>;
  reportMetric(metric: AppMetric): void;
  rollback(request: TransactionRequest): Promise<void>;
  saveConnection(profile: ConnectionProfileInput): Promise<PublicConnectionProfile>;
  saveOracleClient(client: OracleClientInput): Promise<OracleClientDefinition>;
  saveOracleSettings(settings: OracleSettings): Promise<OracleSettings>;
  saveSqlFile(request: SaveSqlFileRequest): Promise<SaveSqlFileResult>;
  saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void>;
  setTitleBarTheme(theme: 'light' | 'dark'): void;
  showConnectionMenu(connectionId: string): Promise<ConnectionMenuAction | undefined>;
  showNewDocumentMenu(): Promise<NewDocumentMenuResult | undefined>;
  testConnection(request: ConnectionTestRequest): Promise<ConnectionTestResult>;
}

export const IPC_CHANNELS = {
  bootstrap: 'app:bootstrap',
  beforeAppClose: 'app:before-close',
  cancel: 'db:cancel',
  chooseDirectory: 'file:choose-directory',
  commit: 'db:commit',
  confirmAppClose: 'app:confirm-close',
  connect: 'db:connect',
  deleteConnection: 'connections:delete',
  deleteOracleClient: 'oracle-client:delete',
  disconnect: 'db:disconnect',
  execute: 'db:execute',
  fetchMore: 'db:fetch-more',
  fileCommand: 'file:command',
  getRecentSqlFiles: 'file:recent',
  listTnsAliases: 'oracle-net:list-aliases',
  openSqlFiles: 'file:open',
  reconnect: 'db:reconnect',
  refreshMetadata: 'db:refresh-metadata',
  reopenSqlFile: 'file:reopen',
  reportMetric: 'app:metric',
  rollback: 'db:rollback',
  saveConnection: 'connections:save',
  saveOracleClient: 'oracle-client:save',
  saveOracleSettings: 'oracle-settings:save',
  saveSqlFile: 'file:save',
  saveWorkspace: 'workspace:save',
  sessionStateChanged: 'db:session-state-changed',
  setTitleBarTheme: 'window:title-bar-theme',
  showConnectionMenu: 'menu:connection',
  showNewDocumentMenu: 'menu:new-document',
  testConnection: 'db:test-connection',
} as const;

export type WorkerMethod =
  | 'cancel'
  | 'close'
  | 'commit'
  | 'connect'
  | 'disconnect'
  | 'execute'
  | 'fetchMore'
  | 'listTnsAliases'
  | 'reconnect'
  | 'refreshMetadata'
  | 'rollback'
  | 'testConnection';

export interface WorkerRequest {
  id: string;
  method: WorkerMethod;
  payload: unknown;
  type: 'request';
}

export interface WorkerResponse {
  error?: DatabaseErrorInfo & { stack?: string };
  id: string;
  result?: unknown;
  type: 'response';
}

export interface WorkerEvent {
  event: 'session-state';
  payload: SessionState;
  type: 'event';
}

export type WorkerMessage = WorkerEvent | WorkerResponse;

export interface DatabaseRuntimeConfiguration {
  configDir?: string;
  kind: DatabaseKind;
  libDir?: string;
  mode?: OracleDriverMode;
  runtimeKey: string;
}
