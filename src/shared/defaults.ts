import type {
  PublicConnectionProfile,
  SqlDocument,
  UiSettings,
  WorkspaceSnapshot,
} from './contracts';
import {
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  UI_SCALE_STEPS,
} from './contracts';

const now = () => new Date().toISOString();

export const DEFAULT_UI_SETTINGS: UiSettings = {
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  interfaceScale: 1,
};

export function normalizeUiSettings(value: unknown): UiSettings {
  const raw = value && typeof value === 'object' ? value as Partial<UiSettings> : {};
  const scale = UI_SCALE_STEPS.find((step) => step === raw.interfaceScale) ?? DEFAULT_UI_SETTINGS.interfaceScale;
  const fontSize = typeof raw.editorFontSize === 'number' && Number.isFinite(raw.editorFontSize)
    ? Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(raw.editorFontSize)))
    : DEFAULT_UI_SETTINGS.editorFontSize;
  return { editorFontSize: fontSize, interfaceScale: scale };
}

const oracleSql = `select
  e.employee_id,
  e.full_name,
  d.department_name,
  e.salary
from employees e
left join departments d
  on d.department_id = e.department_id
order by e.employee_id;`;

const postgresSql = `select schemaname, tablename, tableowner
from pg_catalog.pg_tables
where schemaname not in ('pg_catalog', 'information_schema')
order by schemaname, tablename;`;

export const defaultConnections: PublicConnectionProfile[] = [
  {
    id: 'oracle-local', name: 'Oracle local', kind: 'oracle', color: '#e36b2c',
    host: '127.0.0.1', port: 1521, database: 'XEPDB1', serviceName: 'XEPDB1',
    username: 'SQLX', credentialState: 'missing', profileVersion: 1,
    driverMode: 'thin', addressMode: 'basic', privilege: 'normal', netConfigSource: 'default',
  },
  {
    id: 'postgres-local', name: 'PostgreSQL local', kind: 'postgres', color: '#3676d8',
    host: '127.0.0.1', port: 5432, database: 'sqlexplorer_dev', username: 'sqlx_dev',
    credentialState: 'missing', profileVersion: 1,
  },
];

function makeDocument(
  index: number,
  connectionId: string | null,
  title: string,
  text: string,
  dialect: SqlDocument['dialect'],
): SqlDocument {
  const timestamp = now();
  return {
    id: `document-${index}`, connectionId, createdAt: timestamp, updatedAt: timestamp,
    dialect, dirty: false, text, title, encoding: 'utf8', bom: 'none', eol: 'lf',
    viewState: { cursor: { lineNumber: 1, column: 1 }, scrollLeft: 0, scrollTop: 0 },
  };
}

export function createDefaultWorkspace(connection?: PublicConnectionProfile): WorkspaceSnapshot {
  const document = makeDocument(1, connection?.id ?? null, 'SQL 1', '', connection?.kind ?? 'sql');
  return {
    schemaVersion: 3, activeDocumentId: document.id, closedDocuments: [], documents: [document],
    explorerConnectionId: connection?.id ?? null, explorerVisible: true,
    resultPanelHeight: 268, theme: 'system',
  };
}

export function createDemoWorkspace(): WorkspaceSnapshot {
  const documents = [
    makeDocument(1, 'oracle-local', 'Сотрудники.sql', oracleSql, 'oracle'),
    makeDocument(2, 'postgres-local', 'Объекты.sql', postgresSql, 'postgres'),
    makeDocument(3, 'oracle-local', 'Черновик', 'select * from employee_details;', 'oracle'),
  ];
  return {
    schemaVersion: 3, activeDocumentId: documents[0].id, closedDocuments: [], documents,
    explorerConnectionId: 'oracle-local', explorerVisible: true, resultPanelHeight: 268, theme: 'system',
  };
}

export function createPerformanceWorkspace(documentCount: number, payloadKb = 64): WorkspaceSnapshot {
  const count = Math.max(1, Math.min(500, Math.trunc(documentCount)));
  const padding = `\n/* ${'performance corpus '.repeat(Math.ceil((payloadKb * 1024) / 19))}*/`.slice(0, payloadKb * 1024);
  const documents = Array.from({ length: count }, (_, index) =>
    makeDocument(
      index + 1,
      index % 2 === 0 ? 'oracle-local' : 'postgres-local',
      `Нагрузка ${String(index + 1).padStart(3, '0')}.sql`,
      `${index % 2 === 0 ? oracleSql : postgresSql}${padding}`,
      index % 2 === 0 ? 'oracle' : 'postgres',
    ));
  return {
    ...createDefaultWorkspace(), activeDocumentId: documents[0].id, documents,
    explorerConnectionId: 'oracle-local',
  };
}
