import type {
  AppMetric,
  BootstrapPayload,
  ExecuteRequest,
  MetadataSnapshot,
  QueryColumn,
  QueryPage,
  QueryRow,
  SQLExplorerApi,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createDefaultWorkspace, defaultConnections, defaultMetadata } from '../shared/defaults';

const workspaceKey = 'sqlexplorer.browser.workspace';
const cancelled = new Set<string>();

function browserWorkspace(): WorkspaceSnapshot {
  const saved = localStorage.getItem(workspaceKey);
  if (!saved) return createDefaultWorkspace();
  try {
    return JSON.parse(saved) as WorkspaceSnapshot;
  } catch {
    return createDefaultWorkspace();
  }
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
    executionId,
    status: 'ready',
    columns,
    rows,
    hasMore: false,
    elapsedMs: 84,
    message: '3 rows fetched',
    transactionState: 'clean',
  };
}

function postgresPage(executionId: string): QueryPage {
  const columns: QueryColumn[] = [
    { key: 'column-0', name: 'schemaname', typeName: 'name', nullable: false },
    { key: 'column-1', name: 'tablename', typeName: 'name', nullable: false },
    { key: 'column-2', name: 'tableowner', typeName: 'name', nullable: false },
  ];
  const rows = ['departments', 'employees', 'employee_audit'].map((name, index) => ({
    index: index + 1,
    cells: ['public', name, 'sqlx_dev'],
  }));
  return {
    executionId,
    status: 'ready',
    columns,
    rows,
    hasMore: false,
    elapsedMs: 61,
    message: '3 rows fetched',
    transactionState: 'clean',
  };
}

async function waitForMock(executionId: string): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 360));
  if (cancelled.delete(executionId)) throw new Error('Query cancelled');
}

export const mockApi: SQLExplorerApi = {
  bootstrap(): Promise<BootstrapPayload> {
    return Promise.resolve({
      connections: defaultConnections.map((profile) => ({ ...profile, status: 'configured' })),
      metadata: defaultMetadata,
      platform: 'browser',
      version: '0.1.0-browser',
      workspace: browserWorkspace(),
    });
  },
  async execute(request: ExecuteRequest): Promise<QueryPage> {
    await waitForMock(request.executionId);
    if (/raise_error|syntax_error/iu.test(request.sql)) throw new Error('Demo syntax error near line 1');
    return request.connectionId === 'postgres-local'
      ? postgresPage(request.executionId)
      : oraclePage(request.executionId);
  },
  async fetchMore(request) {
    await waitForMock(request.executionId);
    return { ...oraclePage(request.executionId), rows: [], hasMore: false };
  },
  cancel(executionId) {
    cancelled.add(executionId);
    return Promise.resolve(true);
  },
  commit: () => Promise.resolve(),
  rollback: () => Promise.resolve(),
  async refreshMetadata(connectionId: string): Promise<MetadataSnapshot> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    const metadata = defaultMetadata.find((snapshot) => snapshot.connectionId === connectionId);
    if (!metadata) throw new Error('Unknown demo connection');
    return { ...metadata, fetchedAt: new Date().toISOString() };
  },
  reportMetric(metric: AppMetric) {
    console.info('[metric]', metric);
  },
  saveWorkspace(snapshot: WorkspaceSnapshot) {
    localStorage.setItem(workspaceKey, JSON.stringify(snapshot));
    return Promise.resolve();
  },
  setTitleBarTheme() {},
  async testConnection(connectionId: string) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
    return {
      elapsedMs: 42,
      serverVersion: connectionId === 'oracle-local' ? 'Oracle Database 21c XE' : 'PostgreSQL 10.23',
    };
  },
};

export function getApi(): SQLExplorerApi {
  return window.sqlExplorer ?? mockApi;
}
