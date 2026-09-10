export type DatabaseKind = 'oracle' | 'postgres';
export type ThemePreference = 'light' | 'dark' | 'system';
export type ExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'fetching'
  | 'ready'
  | 'cancel-requested'
  | 'cancelled'
  | 'error';

export interface CursorPosition {
  column: number;
  lineNumber: number;
}

export interface EditorViewState {
  cursor: CursorPosition;
  scrollLeft: number;
  scrollTop: number;
}

export interface SqlDocument {
  connectionId: string;
  createdAt: string;
  dialect: DatabaseKind;
  dirty: boolean;
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
  explorerConnectionId: string;
  explorerVisible: boolean;
  resultPanelHeight: number;
  schemaVersion: 1;
  theme: ThemePreference;
}

export interface PublicConnectionProfile {
  color: string;
  database: string;
  host: string;
  id: string;
  kind: DatabaseKind;
  name: string;
  port: number;
  serviceName?: string;
  status: 'configured' | 'needs-credentials';
  username: string;
}

export interface ConnectionProfile extends PublicConnectionProfile {
  connectString?: string;
  ociLibrary?: string;
  password: string;
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
  transactionState: 'clean' | 'changed' | 'unknown';
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

export interface BootstrapPayload {
  connections: PublicConnectionProfile[];
  metadata: MetadataSnapshot[];
  platform: NodeJS.Platform | 'browser';
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
  commit(request: TransactionRequest): Promise<void>;
  execute(request: ExecuteRequest): Promise<QueryPage>;
  fetchMore(request: FetchMoreRequest): Promise<QueryPage>;
  refreshMetadata(connectionId: string): Promise<MetadataSnapshot>;
  reportMetric(metric: AppMetric): void;
  rollback(request: TransactionRequest): Promise<void>;
  saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void>;
  setTitleBarTheme(theme: 'light' | 'dark'): void;
  testConnection(connectionId: string): Promise<{ elapsedMs: number; serverVersion: string }>;
}

export const IPC_CHANNELS = {
  bootstrap: 'app:bootstrap',
  cancel: 'db:cancel',
  commit: 'db:commit',
  execute: 'db:execute',
  fetchMore: 'db:fetch-more',
  refreshMetadata: 'db:refresh-metadata',
  reportMetric: 'app:metric',
  rollback: 'db:rollback',
  saveWorkspace: 'workspace:save',
  setTitleBarTheme: 'window:title-bar-theme',
  testConnection: 'db:test-connection',
} as const;

export type WorkerMethod =
  | 'cancel'
  | 'close'
  | 'commit'
  | 'execute'
  | 'fetchMore'
  | 'refreshMetadata'
  | 'rollback'
  | 'testConnection';

export interface WorkerRequest {
  id: string;
  method: WorkerMethod;
  payload: unknown;
}

export interface WorkerResponse {
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
  id: string;
  result?: unknown;
}
