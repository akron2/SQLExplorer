import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppMetric,
  BootstrapPayload,
  ExecuteRequest,
  FetchMoreRequest,
  MetadataSnapshot,
  QueryPage,
  SQLExplorerApi,
  TransactionRequest,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';

const api: SQLExplorerApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap) as Promise<BootstrapPayload>,
  cancel: (executionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancel, executionId) as Promise<boolean>,
  commit: (request: TransactionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.commit, request) as Promise<void>,
  execute: (request: ExecuteRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.execute, request) as Promise<QueryPage>,
  fetchMore: (request: FetchMoreRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.fetchMore, request) as Promise<QueryPage>,
  refreshMetadata: (connectionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.refreshMetadata, connectionId) as Promise<MetadataSnapshot>,
  reportMetric: (metric: AppMetric) => ipcRenderer.send(IPC_CHANNELS.reportMetric, metric),
  rollback: (request: TransactionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.rollback, request) as Promise<void>,
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveWorkspace, snapshot) as Promise<void>,
  setTitleBarTheme: (theme: 'light' | 'dark') =>
    ipcRenderer.send(IPC_CHANNELS.setTitleBarTheme, theme),
  testConnection: (connectionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.testConnection, connectionId) as Promise<{
      elapsedMs: number;
      serverVersion: string;
    }>,
};

contextBridge.exposeInMainWorld('sqlExplorer', api);
