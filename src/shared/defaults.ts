import type {
  MetadataSnapshot,
  PublicConnectionProfile,
  SqlDocument,
  WorkspaceSnapshot,
} from './contracts';

const now = () => new Date().toISOString();

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
    id: 'oracle-local',
    name: 'Oracle local',
    kind: 'oracle',
    color: '#e36b2c',
    host: '127.0.0.1',
    port: 1521,
    database: 'XEPDB1',
    serviceName: 'XEPDB1',
    username: 'SQLX',
    status: 'needs-credentials',
  },
  {
    id: 'postgres-local',
    name: 'PostgreSQL local',
    kind: 'postgres',
    color: '#3676d8',
    host: '127.0.0.1',
    port: 5432,
    database: 'sqlexplorer_dev',
    username: 'sqlx_dev',
    status: 'needs-credentials',
  },
];

export const defaultMetadata: MetadataSnapshot[] = [
  {
    connectionId: 'oracle-local',
    schema: 'SQLX',
    fetchedAt: now(),
    objects: [
      {
        kind: 'table',
        schema: 'SQLX',
        name: 'EMPLOYEES',
        columns: [
          { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
          { name: 'DEPARTMENT_ID', dataType: 'NUMBER(10)', nullable: true, position: 2 },
          { name: 'FULL_NAME', dataType: 'VARCHAR2(120)', nullable: false, position: 3 },
          { name: 'SALARY', dataType: 'NUMBER(18,4)', nullable: true, position: 4 },
          { name: 'HIRED_AT', dataType: 'TIMESTAMP', nullable: true, position: 5 },
          { name: 'NOTES', dataType: 'CLOB', nullable: true, position: 6 },
        ],
      },
      {
        kind: 'table',
        schema: 'SQLX',
        name: 'DEPARTMENTS',
        columns: [
          { name: 'DEPARTMENT_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
          { name: 'DEPARTMENT_NAME', dataType: 'VARCHAR2(100)', nullable: false, position: 2 },
        ],
      },
      { kind: 'view', schema: 'SQLX', name: 'EMPLOYEE_DETAILS' },
      { kind: 'package', schema: 'SQLX', name: 'DEMO_PKG' },
      { kind: 'synonym', schema: 'SQLX', name: 'STAFF' },
      { kind: 'sequence', schema: 'SQLX', name: 'EMPLOYEE_ID_SEQ' },
    ],
  },
  {
    connectionId: 'postgres-local',
    schema: 'public',
    fetchedAt: now(),
    objects: [
      { kind: 'table', schema: 'public', name: 'employees' },
      { kind: 'table', schema: 'public', name: 'departments' },
      { kind: 'view', schema: 'public', name: 'employee_details' },
    ],
  },
];

function makeDocument(
  index: number,
  connectionId: string,
  title: string,
  text: string,
  dialect: 'oracle' | 'postgres',
): SqlDocument {
  const timestamp = now();
  return {
    id: `document-${index}`,
    connectionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    dialect,
    dirty: false,
    text,
    title,
    viewState: {
      cursor: { lineNumber: 1, column: 1 },
      scrollLeft: 0,
      scrollTop: 0,
    },
  };
}

export function createDefaultWorkspace(): WorkspaceSnapshot {
  const documents = [
    makeDocument(1, 'oracle-local', 'Сотрудники.sql', oracleSql, 'oracle'),
    makeDocument(2, 'postgres-local', 'Объекты.sql', postgresSql, 'postgres'),
    makeDocument(3, 'oracle-local', 'Черновик', 'select * from employee_details;', 'oracle'),
  ];

  return {
    schemaVersion: 1,
    activeDocumentId: documents[0].id,
    closedDocuments: [],
    documents,
    explorerConnectionId: 'oracle-local',
    explorerVisible: true,
    resultPanelHeight: 268,
    theme: 'system',
  };
}

export function createPerformanceWorkspace(documentCount: number, payloadKb = 64): WorkspaceSnapshot {
  const count = Math.max(1, Math.min(500, Math.trunc(documentCount)));
  const padding = `\n/* ${'performance corpus '.repeat(Math.ceil((payloadKb * 1024) / 19))}*/`.slice(
    0,
    payloadKb * 1024,
  );
  const documents = Array.from({ length: count }, (_, index) =>
    makeDocument(
      index + 1,
      index % 2 === 0 ? 'oracle-local' : 'postgres-local',
      `Нагрузка ${String(index + 1).padStart(3, '0')}.sql`,
      `${index % 2 === 0 ? oracleSql : postgresSql}${padding}`,
      index % 2 === 0 ? 'oracle' : 'postgres',
    ),
  );

  return {
    ...createDefaultWorkspace(),
    activeDocumentId: documents[0].id,
    documents,
  };
}
