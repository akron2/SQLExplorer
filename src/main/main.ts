import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from 'electron';
import type {
  AppMetric,
  BootstrapPayload,
  ExecuteRequest,
  FetchMoreRequest,
  MetadataSnapshot,
  QueryPage,
  TransactionRequest,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { IPC_CHANNELS } from '../shared/contracts';
import { defaultMetadata } from '../shared/defaults';
import { ConnectionRegistry } from './connection-registry';
import { DatabaseWorkerClient } from './db-worker-client';
import { WorkspaceStore } from './workspace-store';

const testUserData = process.env.SQLX_TEST_USER_DATA;
if (testUserData) {
  app.setPath('userData', testUserData);
}

let databaseWorker: DatabaseWorkerClient | undefined;
let workspaceStore: WorkspaceStore | undefined;
let connectionRegistry: ConnectionRegistry | undefined;

function projectRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function connectionConfigRoot(): string {
  const override = process.env.SQLX_CONFIG_ROOT;
  return override && path.isAbsolute(override) ? override : projectRoot();
}

function requireServices() {
  if (!databaseWorker || !workspaceStore || !connectionRegistry) {
    throw new Error('Application services are not initialized');
  }
  return { databaseWorker, workspaceStore, connectionRegistry };
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.bootstrap, (): BootstrapPayload => {
    const services = requireServices();
    return {
      connections: services.connectionRegistry.list(),
      metadata: defaultMetadata,
      platform: process.platform,
      version: app.getVersion(),
      workspace: services.workspaceStore.loadWorkspace(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.saveWorkspace, (_event, snapshot: WorkspaceSnapshot) => {
    requireServices().workspaceStore.saveWorkspace(snapshot);
  });

  ipcMain.handle(IPC_CHANNELS.testConnection, async (_event, connectionId: string) => {
    const services = requireServices();
    return services.databaseWorker.call('testConnection', {
      profile: services.connectionRegistry.get(connectionId),
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.execute,
    async (_event, request: ExecuteRequest): Promise<QueryPage> => {
      const services = requireServices();
      return services.databaseWorker.call<QueryPage>('execute', {
        profile: services.connectionRegistry.get(request.connectionId),
        request,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.fetchMore,
    (_event, request: FetchMoreRequest): Promise<QueryPage> =>
      requireServices().databaseWorker.call<QueryPage>('fetchMore', request),
  );

  ipcMain.handle(IPC_CHANNELS.cancel, (_event, executionId: string): Promise<boolean> =>
    requireServices().databaseWorker.call<boolean>('cancel', { executionId }),
  );

  ipcMain.handle(IPC_CHANNELS.commit, async (_event, request: TransactionRequest) => {
    const services = requireServices();
    await services.databaseWorker.call('commit', {
      profile: services.connectionRegistry.get(request.connectionId),
      request,
    });
  });

  ipcMain.handle(IPC_CHANNELS.rollback, async (_event, request: TransactionRequest) => {
    const services = requireServices();
    await services.databaseWorker.call('rollback', {
      profile: services.connectionRegistry.get(request.connectionId),
      request,
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.refreshMetadata,
    async (_event, connectionId: string): Promise<MetadataSnapshot> => {
      const services = requireServices();
      return services.databaseWorker.call<MetadataSnapshot>('refreshMetadata', {
        profile: services.connectionRegistry.get(connectionId),
      });
    },
  );

  ipcMain.on(IPC_CHANNELS.reportMetric, (_event, metric: AppMetric) => {
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

  const query = performanceQuery();
  const rendererUrl = process.env.SQLX_RENDERER_URL;
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(
      path.join(__dirname, '../renderer/main_window/index.html'),
      query ? { query } : undefined,
    );
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
        if (editor && diagnostics?.editorInstances === 1) {
          resolve(diagnostics);
        } else if (Date.now() >= deadline) {
          reject(new Error('Renderer did not become ready'));
        } else {
          setTimeout(inspect, 50);
        }
      };
      inspect();
    })
  `) as { documentCount: number; editorInstances: number; modelCount: number };

  const [oracle, postgres] = await Promise.all([
    services.databaseWorker.call<{ serverVersion: string }>('testConnection', {
      profile: services.connectionRegistry.get('oracle-local'),
    }),
    services.databaseWorker.call<{ serverVersion: string }>('testConnection', {
      profile: services.connectionRegistry.get('postgres-local'),
    }),
  ]);
  console.log(`PACKAGE_SMOKE_OK renderer=${renderer.editorInstances} oracle=${oracle.serverVersion} postgres=${postgres.serverVersion}`);
}

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.sqlexplorer.desktop');
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'sqlexplorer.sqlite'));
  connectionRegistry = new ConnectionRegistry(connectionConfigRoot());
  databaseWorker = new DatabaseWorkerClient(__dirname);
  registerIpc();
  if (process.argv.includes('--smoke-test')) {
    const services = requireServices();
    await runPackageSmokeTest();
    await services.databaseWorker.close();
    databaseWorker = undefined;
    services.workspaceStore.close();
    workspaceStore = undefined;
    app.exit(0);
    return;
  }
  await createWindow();
}).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  workspaceStore?.close();
  workspaceStore = undefined;
  if (databaseWorker) {
    void databaseWorker.close();
    databaseWorker = undefined;
  }
});
