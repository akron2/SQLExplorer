import { parentPort } from 'node:worker_threads';
import oracledb from 'oracledb';
import pg from 'pg';
import Cursor from 'pg-cursor';
import type {
  CellValue,
  ConnectionProfile,
  ExecuteRequest,
  FetchMoreRequest,
  MetadataColumn,
  MetadataObject,
  MetadataSnapshot,
  QueryColumn,
  QueryPage,
  QueryRow,
  TransactionRequest,
  WorkerRequest,
  WorkerResponse,
} from '../shared/contracts';

const { Client } = pg;
const workerPort = parentPort;

if (!workerPort) throw new Error('Database worker must run in a worker thread');

oracledb.fetchAsString = [oracledb.NUMBER, oracledb.DATE];

interface OracleSession {
  activeExecutionId?: string;
  changed: boolean;
  connection: oracledb.Connection;
  kind: 'oracle';
  profile: ConnectionProfile;
  sessionKey: string;
}

interface PostgresSession {
  activeExecutionId?: string;
  changed: boolean;
  client: InstanceType<typeof Client>;
  kind: 'postgres';
  profile: ConnectionProfile;
  sessionKey: string;
  transactionOpen: boolean;
}

type DatabaseSession = OracleSession | PostgresSession;

interface OracleCursorState {
  columns: QueryColumn[];
  kind: 'oracle';
  offset: number;
  resultSet: oracledb.ResultSet<unknown[]>;
  sessionKey: string;
  startedAt: number;
}

interface PostgresCursorState {
  columns: QueryColumn[];
  cursor: Cursor<Record<string, unknown>>;
  kind: 'postgres';
  offset: number;
  sessionKey: string;
  startedAt: number;
}

type CursorState = OracleCursorState | PostgresCursorState;

const sessions = new Map<string, DatabaseSession>();
const cursors = new Map<string, CursorState>();

function sessionKey(connectionId: string, documentId: string): string {
  return `${connectionId}:${documentId}`;
}

function pageSize(value: number): number {
  if (!Number.isFinite(value)) return 300;
  return Math.max(1, Math.min(1_000, Math.trunc(value)));
}

function ensureSql(sql: string): string {
  const value = sql.trim();
  if (!value) throw new Error('SQL text is empty');
  if (value.length > 10 * 1024 * 1024) throw new Error('SQL text exceeds the 10 MiB safety limit');
  return value;
}

function commandName(sql: string): string {
  const withoutComments = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trimStart();
  return withoutComments.match(/^([a-z]+)/iu)?.[1]?.toUpperCase() ?? 'SQL';
}

function oracleDriverSql(sql: string): string {
  const value = ensureSql(sql);
  const command = commandName(value);
  if (command === 'BEGIN' || command === 'DECLARE') {
    return value.replace(/\n\s*\/\s*$/u, '').trimEnd();
  }
  return value.replace(/;\s*$/u, '').trimEnd();
}

function changesTransaction(sql: string, kind: 'oracle' | 'postgres'): boolean {
  const command = commandName(sql);
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL', 'DO', 'BEGIN', 'DECLARE'].includes(command)) {
    return true;
  }
  return kind === 'postgres' && ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'].includes(command);
}

function serializeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `base64:${value.toString('base64')}`;
  if (value instanceof Uint8Array) return `base64:${Buffer.from(value).toString('base64')}`;
  if (typeof value === 'object' && value && 'getData' in value) {
    const typeName = value.constructor?.name || 'LOB';
    return `<${typeName}: open in value viewer>`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function oracleColumns(metadata: oracledb.Metadata<unknown[]>[]): QueryColumn[] {
  return metadata.map((column, index) => ({
    key: `column-${index}`,
    name: column.name,
    typeName: column.dbTypeName ?? 'UNKNOWN',
    nullable: column.nullable ?? true,
  }));
}

function postgresColumns(fields: pg.FieldDef[]): QueryColumn[] {
  return fields.map((field, index) => ({
    key: `column-${index}`,
    name: field.name,
    typeName: `OID ${field.dataTypeID}`,
    nullable: true,
  }));
}

function arrayRows(rows: unknown[][], offset: number): QueryRow[] {
  return rows.map((row, rowIndex) => ({
    index: offset + rowIndex + 1,
    cells: row.map(serializeCell),
  }));
}

function objectRows(
  rows: Record<string, unknown>[],
  columns: QueryColumn[],
  offset: number,
): QueryRow[] {
  return rows.map((row, rowIndex) => ({
    index: offset + rowIndex + 1,
    cells: columns.map((column) => serializeCell(row[column.name])),
  }));
}

function readPostgresCursor<Row extends Record<string, unknown>>(
  cursor: Cursor<Row>,
  size: number,
): Promise<{ result: pg.QueryResult<Row>; rows: Row[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(size, (error, rows, result) => {
      if (error) reject(error);
      else resolve({ rows, result });
    });
  });
}

async function createSession(
  profile: ConnectionProfile,
  documentId: string,
): Promise<DatabaseSession> {
  const key = sessionKey(profile.id, documentId);
  const existing = sessions.get(key);
  if (existing) return existing;

  if (profile.kind === 'oracle') {
    const connection = await oracledb.getConnection({
      user: profile.username,
      password: profile.password,
      connectString: profile.connectString ?? `${profile.host}:${profile.port}/${profile.serviceName}`,
    });
    const created: OracleSession = {
      kind: 'oracle',
      connection,
      profile,
      sessionKey: key,
      changed: false,
    };
    sessions.set(key, created);
    return created;
  }

  const client = new Client({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    application_name: 'SQLExplorer',
    keepAlive: true,
  });
  await client.connect();
  const created: PostgresSession = {
    kind: 'postgres',
    client,
    profile,
    sessionKey: key,
    changed: false,
    transactionOpen: false,
  };
  sessions.set(key, created);
  return created;
}

async function closeCursor(executionId: string): Promise<void> {
  const state = cursors.get(executionId);
  if (!state) return;
  cursors.delete(executionId);
  try {
    if (state.kind === 'oracle') await state.resultSet.close();
    else await state.cursor.close();
  } catch {
    // The driver can already have closed the cursor after cancellation or a connection failure.
  }
}

async function closeSessionCursors(key: string): Promise<void> {
  const executionIds = [...cursors.entries()]
    .filter(([, cursor]) => cursor.sessionKey === key)
    .map(([executionId]) => executionId);
  await Promise.all(executionIds.map(closeCursor));
}

async function executeOracle(
  session: OracleSession,
  request: ExecuteRequest,
): Promise<QueryPage> {
  const size = pageSize(request.pageSize);
  const startedAt = performance.now();
  session.activeExecutionId = request.executionId;
  try {
    const result = await session.connection.execute<unknown[]>(
      oracleDriverSql(request.sql),
      request.parameters ?? {},
      {
        autoCommit: false,
        fetchArraySize: size,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        resultSet: true,
      },
    );

    if (result.resultSet && result.metaData) {
      const columns = oracleColumns(result.metaData);
      const rows = await result.resultSet.getRows(size);
      const hasMore = rows.length === size;
      if (hasMore) {
        cursors.set(request.executionId, {
          kind: 'oracle',
          resultSet: result.resultSet,
          columns,
          offset: rows.length,
          sessionKey: session.sessionKey,
          startedAt,
        });
      } else {
        await result.resultSet.close();
      }
      return {
        executionId: request.executionId,
        status: 'ready',
        columns,
        rows: arrayRows(rows, 0),
        hasMore,
        elapsedMs: performance.now() - startedAt,
        message: `${rows.length} rows fetched`,
        transactionState: session.changed ? 'changed' : 'clean',
      };
    }

    if (changesTransaction(request.sql, 'oracle')) session.changed = true;
    return {
      executionId: request.executionId,
      status: 'ready',
      columns: [],
      rows: [],
      hasMore: false,
      rowsAffected: result.rowsAffected,
      elapsedMs: performance.now() - startedAt,
      message: `${commandName(request.sql)} completed${result.rowsAffected === undefined ? '' : ` · ${result.rowsAffected} affected`}`,
      transactionState: session.changed ? 'changed' : 'clean',
    };
  } finally {
    session.activeExecutionId = undefined;
  }
}

async function ensurePostgresTransaction(session: PostgresSession): Promise<void> {
  if (!session.transactionOpen) {
    await session.client.query('BEGIN');
    session.transactionOpen = true;
  }
}

async function executePostgres(
  session: PostgresSession,
  request: ExecuteRequest,
): Promise<QueryPage> {
  const size = pageSize(request.pageSize);
  const startedAt = performance.now();
  await ensurePostgresTransaction(session);
  const values = request.parameters ? Object.values(request.parameters) : [];
  const cursor = session.client.query(new Cursor<Record<string, unknown>>(ensureSql(request.sql), values));
  session.activeExecutionId = request.executionId;
  try {
    const { rows, result } = await readPostgresCursor(cursor, size);
    const fields = result.fields;
    const columns = postgresColumns(fields);
    const hasMore = columns.length > 0 && rows.length === size;
    if (hasMore) {
      cursors.set(request.executionId, {
        kind: 'postgres',
        cursor,
        columns,
        offset: rows.length,
        sessionKey: session.sessionKey,
        startedAt,
      });
    } else {
      await cursor.close();
    }
    if (changesTransaction(request.sql, 'postgres')) session.changed = true;
    const rowsAffected = result.rowCount ?? undefined;
    return {
      executionId: request.executionId,
      status: 'ready',
      columns,
      rows: objectRows(rows, columns, 0),
      hasMore,
      rowsAffected,
      elapsedMs: performance.now() - startedAt,
      message: columns.length
        ? `${rows.length} rows fetched`
        : `${result.command || commandName(request.sql)} completed${rowsAffected === undefined ? '' : ` · ${rowsAffected} affected`}`,
      transactionState: session.changed ? 'changed' : 'clean',
    };
  } finally {
    session.activeExecutionId = undefined;
  }
}

async function execute(payload: {
  profile: ConnectionProfile;
  request: ExecuteRequest;
}): Promise<QueryPage> {
  const { profile, request } = payload;
  const session = await createSession(profile, request.documentId);
  if (session.activeExecutionId) throw new Error('Another command is already running in this document');
  await closeSessionCursors(session.sessionKey);
  return session.kind === 'oracle'
    ? executeOracle(session, request)
    : executePostgres(session, request);
}

async function fetchMore(request: FetchMoreRequest): Promise<QueryPage> {
  const state = cursors.get(request.executionId);
  if (!state) throw new Error('The result cursor is no longer available');
  const size = pageSize(request.pageSize);
  const session = sessions.get(state.sessionKey);
  if (!session) throw new Error('The database session is no longer available');
  session.activeExecutionId = request.executionId;
  try {
    if (state.kind === 'oracle') {
      const values = await state.resultSet.getRows(size);
      const rows = arrayRows(values, state.offset);
      state.offset += rows.length;
      const hasMore = rows.length === size;
      if (!hasMore) await closeCursor(request.executionId);
      return {
        executionId: request.executionId,
        status: 'ready',
        columns: state.columns,
        rows,
        hasMore,
        elapsedMs: performance.now() - state.startedAt,
        message: `${state.offset} rows fetched`,
        transactionState: session.changed ? 'changed' : 'clean',
      };
    }

    const { rows: values } = await readPostgresCursor(state.cursor, size);
    const rows = objectRows(values, state.columns, state.offset);
    state.offset += rows.length;
    const hasMore = rows.length === size;
    if (!hasMore) await closeCursor(request.executionId);
    return {
      executionId: request.executionId,
      status: 'ready',
      columns: state.columns,
      rows,
      hasMore,
      elapsedMs: performance.now() - state.startedAt,
      message: `${state.offset} rows fetched`,
      transactionState: session.changed ? 'changed' : 'clean',
    };
  } finally {
    session.activeExecutionId = undefined;
  }
}

async function cancel(executionId: string): Promise<boolean> {
  const state = cursors.get(executionId);
  const session = state
    ? sessions.get(state.sessionKey)
    : [...sessions.values()].find((candidate) => candidate.activeExecutionId === executionId);
  if (!session) return false;

  if (session.kind === 'oracle') {
    await session.connection.break();
  } else {
    const control = new Client({
      host: session.profile.host,
      port: session.profile.port,
      database: session.profile.database,
      user: session.profile.username,
      password: session.profile.password,
      application_name: 'SQLExplorer cancel',
    });
    await control.connect();
    try {
      const processId = (session.client as typeof session.client & { processID: number }).processID;
      await control.query('SELECT pg_cancel_backend($1)', [processId]);
    } finally {
      await control.end();
    }
  }
  await closeCursor(executionId);
  return true;
}

async function transaction(
  action: 'commit' | 'rollback',
  payload: { profile: ConnectionProfile; request: TransactionRequest },
): Promise<void> {
  const session = await createSession(payload.profile, payload.request.documentId);
  await closeSessionCursors(session.sessionKey);
  if (session.kind === 'oracle') {
    await session.connection[action]();
  } else if (session.transactionOpen) {
    await session.client.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
    session.transactionOpen = false;
  }
  session.changed = false;
}

async function testConnection(profile: ConnectionProfile): Promise<{
  elapsedMs: number;
  serverVersion: string;
}> {
  const startedAt = performance.now();
  if (profile.kind === 'oracle') {
    const connection = await oracledb.getConnection({
      user: profile.username,
      password: profile.password,
      connectString: profile.connectString ?? `${profile.host}:${profile.port}/${profile.serviceName}`,
    });
    try {
      return {
        elapsedMs: performance.now() - startedAt,
        serverVersion: connection.oracleServerVersionString,
      };
    } finally {
      await connection.close();
    }
  }
  const client = new Client({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    application_name: 'SQLExplorer connection test',
  });
  await client.connect();
  try {
    const result = await client.query<{ version: string }>('SELECT version()');
    return {
      elapsedMs: performance.now() - startedAt,
      serverVersion: result.rows[0]?.version ?? 'PostgreSQL',
    };
  } finally {
    await client.end();
  }
}

function oracleType(column: Record<string, unknown>): string {
  const valueText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
    return 'UNKNOWN';
  };
  const dataType = valueText(column.DATA_TYPE);
  if (column.DATA_PRECISION != null) {
    const scale = column.DATA_SCALE == null ? '' : `,${valueText(column.DATA_SCALE)}`;
    return `${dataType}(${valueText(column.DATA_PRECISION)}${scale})`;
  }
  if (column.DATA_LENGTH != null && ['VARCHAR2', 'CHAR', 'RAW'].includes(dataType)) {
    return `${dataType}(${valueText(column.DATA_LENGTH)})`;
  }
  return dataType;
}

async function oracleMetadata(profile: ConnectionProfile): Promise<MetadataSnapshot> {
  const connection = await oracledb.getConnection({
    user: profile.username,
    password: profile.password,
    connectString: profile.connectString ?? `${profile.host}:${profile.port}/${profile.serviceName}`,
  });
  try {
    const [objectResult, columnResult] = await Promise.all([
      connection.execute<Record<string, unknown>>(
        `select object_name, object_type
         from user_objects
         where object_type in ('TABLE', 'VIEW', 'PACKAGE', 'SEQUENCE', 'SYNONYM', 'FUNCTION')
         order by object_type, object_name`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
      connection.execute<Record<string, unknown>>(
        `select table_name, column_name, data_type, data_length, data_precision,
                data_scale, nullable, column_id
         from user_tab_columns
         order by table_name, column_id`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
    ]);
    const columnsByObject = new Map<string, MetadataColumn[]>();
    for (const column of columnResult.rows ?? []) {
      const name = String(column.TABLE_NAME);
      const columns = columnsByObject.get(name) ?? [];
      columns.push({
        name: String(column.COLUMN_NAME),
        dataType: oracleType(column),
        nullable: column.NULLABLE === 'Y',
        position: Number(column.COLUMN_ID),
      });
      columnsByObject.set(name, columns);
    }
    const kindMap: Record<string, MetadataObject['kind']> = {
      TABLE: 'table',
      VIEW: 'view',
      PACKAGE: 'package',
      SEQUENCE: 'sequence',
      SYNONYM: 'synonym',
      FUNCTION: 'function',
    };
    const schema = profile.username.toUpperCase();
    return {
      connectionId: profile.id,
      schema,
      fetchedAt: new Date().toISOString(),
      objects: (objectResult.rows ?? []).map((object: Record<string, unknown>) => {
        const name = String(object.OBJECT_NAME);
        return {
          schema,
          name,
          kind: kindMap[String(object.OBJECT_TYPE)] ?? 'table',
          columns: columnsByObject.get(name),
        };
      }),
    };
  } finally {
    await connection.close();
  }
}

async function postgresMetadata(profile: ConnectionProfile): Promise<MetadataSnapshot> {
  const client = new Client({
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.username,
    password: profile.password,
    application_name: 'SQLExplorer metadata',
  });
  await client.connect();
  try {
    const result = await client.query<{
      column_name: string | null;
      data_type: string | null;
      is_nullable: 'YES' | 'NO' | null;
      object_name: string;
      object_type: 'BASE TABLE' | 'VIEW';
      ordinal_position: number | null;
      table_schema: string;
    }>(`
      select t.table_schema, t.table_name as object_name, t.table_type as object_type,
             c.column_name, c.data_type, c.is_nullable, c.ordinal_position
      from information_schema.tables t
      left join information_schema.columns c
        on c.table_schema = t.table_schema and c.table_name = t.table_name
      where t.table_schema not in ('pg_catalog', 'information_schema')
      order by t.table_schema, t.table_name, c.ordinal_position
    `);
    const objects = new Map<string, MetadataObject>();
    for (const row of result.rows) {
      const key = `${row.table_schema}.${row.object_name}`;
      let object = objects.get(key);
      if (!object) {
        object = {
          schema: row.table_schema,
          name: row.object_name,
          kind: row.object_type === 'VIEW' ? 'view' : 'table',
          columns: [],
        };
        objects.set(key, object);
      }
      if (row.column_name && row.data_type && row.ordinal_position) {
        object.columns?.push({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          position: row.ordinal_position,
        });
      }
    }
    return {
      connectionId: profile.id,
      schema: 'public',
      fetchedAt: new Date().toISOString(),
      objects: [...objects.values()],
    };
  } finally {
    await client.end();
  }
}

async function refreshMetadata(profile: ConnectionProfile): Promise<MetadataSnapshot> {
  return profile.kind === 'oracle' ? oracleMetadata(profile) : postgresMetadata(profile);
}

async function closeAll(): Promise<void> {
  await Promise.all([...cursors.keys()].map(closeCursor));
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      try {
        if (session.changed) {
          if (session.kind === 'oracle') await session.connection.rollback();
          else if (session.transactionOpen) await session.client.query('ROLLBACK');
        }
      } finally {
        if (session.kind === 'oracle') await session.connection.close();
        else await session.client.end();
      }
    }),
  );
  sessions.clear();
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case 'execute':
      return execute(request.payload as { profile: ConnectionProfile; request: ExecuteRequest });
    case 'fetchMore':
      return fetchMore(request.payload as FetchMoreRequest);
    case 'cancel':
      return cancel((request.payload as { executionId: string }).executionId);
    case 'commit':
      return transaction(
        'commit',
        request.payload as { profile: ConnectionProfile; request: TransactionRequest },
      );
    case 'rollback':
      return transaction(
        'rollback',
        request.payload as { profile: ConnectionProfile; request: TransactionRequest },
      );
    case 'testConnection':
      return testConnection((request.payload as { profile: ConnectionProfile }).profile);
    case 'refreshMetadata':
      return refreshMetadata((request.payload as { profile: ConnectionProfile }).profile);
    case 'close':
      return closeAll();
    default:
      throw new Error(`Unsupported database worker method: ${String(request.method)}`);
  }
}

workerPort.on('message', (request: WorkerRequest) => {
  void dispatch(request)
    .then((result) => {
      const response: WorkerResponse = { id: request.id, result };
      workerPort.postMessage(response);
    })
    .catch((error: unknown) => {
      const value = error instanceof Error ? error : new Error(String(error));
      const response: WorkerResponse = {
        id: request.id,
        error: {
          code: 'code' in value ? String(value.code) : value.name,
          message: value.message,
          stack: value.stack,
        },
      };
      workerPort.postMessage(response);
    });
});
