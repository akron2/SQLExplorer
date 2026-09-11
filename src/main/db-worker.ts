import oracledb from 'oracledb';
import pg from 'pg';
import Cursor from 'pg-cursor';
import type {
  CellValue,
  ConnectionProfile,
  ConnectionTestResult,
  DatabaseErrorInfo,
  DatabaseRuntimeConfiguration,
  ExecuteRequest,
  FetchMoreRequest,
  MetadataColumn,
  MetadataObject,
  MetadataSnapshot,
  QueryColumn,
  QueryPage,
  QueryRow,
  SessionRequest,
  SessionState,
  TransactionRequest,
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
} from '../shared/contracts';

const { Client } = pg;
const workerPort = process.parentPort;

if (!workerPort) throw new Error('Database runtime must run as an Electron utility process');

const runtime = (() => {
  try {
    return JSON.parse(process.env.SQLX_RUNTIME_CONFIG ?? '') as DatabaseRuntimeConfiguration;
  } catch {
    throw new Error('Database runtime configuration is missing or invalid');
  }
})();

let initializationError: DatabaseErrorInfo | undefined;
if (runtime.kind === 'oracle') {
  try {
    if (runtime.mode === 'thick') {
      const options: { configDir?: string; libDir?: string } = {};
      if (runtime.configDir) options.configDir = runtime.configDir;
      if (runtime.libDir) options.libDir = runtime.libDir;
      oracledb.initOracleClient(options);
    }
    oracledb.fetchAsString = [oracledb.NUMBER, oracledb.DATE];
  } catch (error) {
    initializationError = databaseError(error, 'configuration');
  }
}

interface BaseSession {
  activeExecutionId?: string;
  changed: boolean;
  connectionId: string;
  connectedAt: string;
  documentId: string;
  lastActivityAt: string;
  profile: ConnectionProfile;
  profileVersion: number;
  sessionKey: string;
}

interface OracleSession extends BaseSession {
  connection: oracledb.Connection;
  kind: 'oracle';
}

interface PostgresSession extends BaseSession {
  client: InstanceType<typeof Client>;
  kind: 'postgres';
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

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return String(error.code);
}

function databaseError(error: unknown, fallback: DatabaseErrorInfo['kind'] = 'unknown'): DatabaseErrorInfo {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = errorCode(error);
  const message = value.message;
  const recoverable = Boolean(error && typeof error === 'object' && 'isRecoverable' in error && error.isRecoverable);
  let kind = fallback;
  if (/cancel|break|ORA-01013/iu.test(message) || code === '57014') kind = 'cancelled';
  else if (code === '28P01' || /ORA-01017|invalid.*credential|password authentication failed/iu.test(message)) {
    kind = 'authentication';
  } else if (
    recoverable ||
    Boolean(code && (code.startsWith('08') || [
      'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH',
    ].includes(code))) ||
    /ORA-03113|ORA-03114|ORA-03135|DPI-1010|DPI-1080|NJS-003|NJS-500|connection.*(?:closed|lost|terminated)|not connected/iu.test(message)
  ) {
    kind = 'connection';
  } else if (
    /DPI-1047|NJS-045|ORA-12154|ORA-12504|ORA-12505|ORA-12514|ORA-12541|tnsnames|Oracle Client/iu.test(message)
  ) {
    kind = 'configuration';
  } else if (code === '25P02' || /transaction/iu.test(message) && fallback === 'transaction') {
    kind = 'transaction';
  } else if (fallback === 'unknown') {
    kind = 'sql';
  }
  return { code, kind, message, retryable: kind === 'connection' };
}

function isConnectionError(error: unknown): boolean {
  return databaseError(error).kind === 'connection';
}

function serializeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
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
  return rows.map((row, rowIndex) => ({ index: offset + rowIndex + 1, cells: row.map(serializeCell) }));
}

function objectRows(rows: Record<string, unknown>[], columns: QueryColumn[], offset: number): QueryRow[] {
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

function transactionState(session: DatabaseSession): SessionState['transactionState'] {
  return session.changed ? 'changed' : 'clean';
}

function stateFor(session: DatabaseSession, status: SessionState['status'], error?: DatabaseErrorInfo): SessionState {
  return {
    connectionId: session.connectionId,
    documentId: session.documentId,
    profileVersion: session.profileVersion,
    runtimeKey: runtime.runtimeKey,
    status,
    transactionState: transactionState(session),
    connectedAt: session.connectedAt,
    lastActivityAt: session.lastActivityAt,
    error,
  };
}

function emitState(state: SessionState): void {
  const event: WorkerEvent = { type: 'event', event: 'session-state', payload: state };
  workerPort.postMessage(event);
}

function disconnectedState(profile: ConnectionProfile, documentId: string): SessionState {
  return {
    connectionId: profile.id,
    documentId,
    profileVersion: profile.profileVersion,
    runtimeKey: runtime.runtimeKey,
    status: 'disconnected',
    transactionState: 'clean',
  };
}

function connectingState(profile: ConnectionProfile, documentId: string): SessionState {
  return { ...disconnectedState(profile, documentId), status: 'connecting' };
}

function oracleConnectionAttributes(profile: ConnectionProfile) {
  const addressMode = profile.addressMode ?? 'basic';
  const connectString = addressMode === 'tnsAlias'
    ? profile.tnsAlias ?? profile.database
    : addressMode === 'connectString'
      ? profile.connectString ?? profile.database
      : `${profile.host}:${profile.port}/${profile.serviceName ?? profile.database}`;
  return {
    user: profile.username,
    password: profile.password,
    connectString,
    configDir: runtime.mode === 'thin' ? profile.effectiveNetConfigDir : undefined,
    privilege: profile.privilege === 'sysdba' ? oracledb.SYSDBA : undefined,
  };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error(message), { code: 'ETIMEDOUT' });
          reject(error);
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeCursor(executionId: string, suppressErrors = true): Promise<void> {
  const state = cursors.get(executionId);
  if (!state) return;
  cursors.delete(executionId);
  try {
    const closing = state.kind === 'oracle' ? state.resultSet.close() : state.cursor.close();
    await settleWithin(closing, 3_000, 'Timed out while closing a result cursor');
  } catch (error) {
    if (!suppressErrors) throw error;
  }
}

async function closeSessionCursors(key: string, suppressErrors = false): Promise<void> {
  const executionIds = [...cursors.entries()]
    .filter(([, cursor]) => cursor.sessionKey === key)
    .map(([executionId]) => executionId);
  await Promise.all(executionIds.map((executionId) => closeCursor(executionId, suppressErrors)));
}

async function invalidateSession(
  session: DatabaseSession,
  error: unknown,
  transactionLost = session.changed,
): Promise<void> {
  if (sessions.get(session.sessionKey) !== session) return;
  sessions.delete(session.sessionKey);
  await closeSessionCursors(session.sessionKey, true);
  const info = databaseError(error, 'connection');
  emitState({
    ...stateFor(session, 'lost', info),
    transactionState: transactionLost ? 'lost' : 'unknown',
  });
  try {
    if (session.kind === 'oracle') await session.connection.close();
    else await session.client.end();
  } catch {
    // Already disconnected.
  }
}

async function closeSession(session: DatabaseSession, force: boolean): Promise<SessionState> {
  if (session.changed && !force) {
    const error = new Error('Сначала выполните Commit или Rollback для этой вкладки');
    const info = databaseError(error, 'transaction');
    throw Object.assign(error, { databaseError: info });
  }
  sessions.delete(session.sessionKey);
  await closeSessionCursors(session.sessionKey, true);
  try {
    if (session.changed) {
      if (session.kind === 'oracle') await session.connection.rollback();
      else if (session.transactionOpen) await session.client.query('ROLLBACK');
    }
  } finally {
    if (session.kind === 'oracle') await session.connection.close();
    else await session.client.end();
  }
  const state = disconnectedState(session.profile, session.documentId);
  emitState(state);
  return state;
}

async function createSession(profile: ConnectionProfile, documentId: string): Promise<DatabaseSession> {
  if (initializationError) throw Object.assign(new Error(initializationError.message), { databaseError: initializationError });
  if (profile.kind !== runtime.kind) throw new Error(`Profile ${profile.kind} was routed to ${runtime.kind}`);
  if (profile.kind === 'oracle' && profile.driverMode !== runtime.mode) {
    throw new Error(`Oracle ${profile.driverMode} profile was routed to ${runtime.mode} runtime`);
  }
  const key = sessionKey(profile.id, documentId);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.profileVersion !== profile.profileVersion) {
      await closeSession(existing, false);
    } else if (existing.kind === 'oracle' && !existing.connection.isHealthy()) {
      await invalidateSession(existing, new Error('Oracle connection is no longer healthy'));
    } else {
      return existing;
    }
  }
  const other = [...sessions.values()].find((session) => session.documentId === documentId);
  if (other) await closeSession(other, false);

  emitState(connectingState(profile, documentId));
  try {
    const now = new Date().toISOString();
    if (profile.kind === 'oracle') {
      const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
      const created: OracleSession = {
        kind: 'oracle', connection, profile, sessionKey: key,
        connectionId: profile.id, documentId, profileVersion: profile.profileVersion,
        changed: false, connectedAt: now, lastActivityAt: now,
      };
      sessions.set(key, created);
      emitState(stateFor(created, 'connected'));
      return created;
    }

    const client = new Client({
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.username,
      password: profile.password,
      application_name: 'SQLExplorer',
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });
    await client.connect();
    const created: PostgresSession = {
      kind: 'postgres', client, profile, sessionKey: key,
      connectionId: profile.id, documentId, profileVersion: profile.profileVersion,
      changed: false, transactionOpen: false, connectedAt: now, lastActivityAt: now,
    };
    sessions.set(key, created);
    client.on('error', (error) => { void invalidateSession(created, error); });
    client.on('end', () => {
      if (sessions.get(key) === created) void invalidateSession(created, new Error('PostgreSQL connection ended'));
    });
    emitState(stateFor(created, 'connected'));
    return created;
  } catch (error) {
    const info = databaseError(error, 'connection');
    emitState({ ...connectingState(profile, documentId), status: 'error', error: info });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { databaseError: info });
  }
}

async function connect(payload: { profile: ConnectionProfile; request: SessionRequest }): Promise<SessionState> {
  const session = await createSession(payload.profile, payload.request.documentId);
  return stateFor(session, 'connected');
}

async function disconnect(payload: { profile: ConnectionProfile; request: SessionRequest }): Promise<SessionState> {
  const key = sessionKey(payload.profile.id, payload.request.documentId);
  const session = sessions.get(key);
  if (!session) {
    const state = disconnectedState(payload.profile, payload.request.documentId);
    emitState(state);
    return state;
  }
  return closeSession(session, Boolean(payload.request.force));
}

async function reconnect(payload: { profile: ConnectionProfile; request: SessionRequest }): Promise<SessionState> {
  const key = sessionKey(payload.profile.id, payload.request.documentId);
  const session = sessions.get(key);
  if (session) await closeSession(session, Boolean(payload.request.force));
  const created = await createSession(payload.profile, payload.request.documentId);
  return stateFor(created, 'connected');
}

async function executeOracle(session: OracleSession, request: ExecuteRequest): Promise<QueryPage> {
  const size = pageSize(request.pageSize);
  const startedAt = performance.now();
  session.activeExecutionId = request.executionId;
  try {
    const result = await session.connection.execute<unknown[]>(
      oracleDriverSql(request.sql),
      request.parameters ?? {},
      { autoCommit: false, fetchArraySize: size, outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true },
    );
    session.lastActivityAt = new Date().toISOString();
    if (result.resultSet && result.metaData) {
      const columns = oracleColumns(result.metaData);
      const rows = await result.resultSet.getRows(size);
      const hasMore = rows.length === size;
      if (hasMore) {
        cursors.set(request.executionId, {
          kind: 'oracle', resultSet: result.resultSet, columns, offset: rows.length,
          sessionKey: session.sessionKey, startedAt,
        });
      } else await result.resultSet.close();
      emitState(stateFor(session, 'connected'));
      return {
        executionId: request.executionId, status: 'ready', columns, rows: arrayRows(rows, 0), hasMore,
        elapsedMs: performance.now() - startedAt, message: `${rows.length} rows fetched`,
        transactionState: transactionState(session),
      };
    }
    const command = commandName(request.sql);
    if (command === 'COMMIT' || command === 'ROLLBACK'
      || ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'].includes(command)) {
      session.changed = false;
    } else if (changesTransaction(request.sql, 'oracle')) session.changed = true;
    emitState(stateFor(session, 'connected'));
    return {
      executionId: request.executionId, status: 'ready', columns: [], rows: [], hasMore: false,
      rowsAffected: result.rowsAffected, elapsedMs: performance.now() - startedAt,
      message: `${command} completed${result.rowsAffected === undefined ? '' : ` · ${result.rowsAffected} affected`}`,
      transactionState: transactionState(session),
    };
  } catch (error) {
    if (isConnectionError(error)) {
      await invalidateSession(session, error, session.changed || changesTransaction(request.sql, 'oracle'));
    }
    throw error;
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

async function executePostgres(session: PostgresSession, request: ExecuteRequest): Promise<QueryPage> {
  const size = pageSize(request.pageSize);
  const startedAt = performance.now();
  session.activeExecutionId = request.executionId;
  try {
    await ensurePostgresTransaction(session);
    const values = request.parameters ? Object.values(request.parameters) : [];
    const cursor = session.client.query(new Cursor<Record<string, unknown>>(ensureSql(request.sql), values));
    const { rows, result } = await readPostgresCursor(cursor, size);
    const columns = postgresColumns(result.fields);
    const hasMore = columns.length > 0 && rows.length === size;
    if (hasMore) {
      cursors.set(request.executionId, {
        kind: 'postgres', cursor, columns, offset: rows.length,
        sessionKey: session.sessionKey, startedAt,
      });
    } else await cursor.close();
    const command = commandName(request.sql);
    if (command === 'COMMIT' || command === 'ROLLBACK') {
      session.transactionOpen = false;
      session.changed = false;
    } else if (changesTransaction(request.sql, 'postgres')) session.changed = true;
    session.lastActivityAt = new Date().toISOString();
    emitState(stateFor(session, 'connected'));
    const rowsAffected = result.rowCount ?? undefined;
    return {
      executionId: request.executionId, status: 'ready', columns,
      rows: objectRows(rows, columns, 0), hasMore, rowsAffected,
      elapsedMs: performance.now() - startedAt,
      message: columns.length
        ? `${rows.length} rows fetched`
        : `${result.command || command} completed${rowsAffected === undefined ? '' : ` · ${rowsAffected} affected`}`,
      transactionState: transactionState(session),
    };
  } catch (error) {
    if (isConnectionError(error)) {
      await invalidateSession(session, error, session.changed || changesTransaction(request.sql, 'postgres'));
    } else if (session.transactionOpen) {
      session.changed = true;
      emitState(stateFor(session, 'connected', databaseError(error, 'sql')));
    }
    throw error;
  } finally {
    session.activeExecutionId = undefined;
  }
}

async function execute(payload: { profile: ConnectionProfile; request: ExecuteRequest }): Promise<QueryPage> {
  const { profile, request } = payload;
  const session = await createSession(profile, request.documentId);
  if (session.activeExecutionId) throw new Error('Another command is already running in this document');
  try {
    await closeSessionCursors(session.sessionKey);
  } catch (error) {
    await invalidateSession(session, error);
    throw error;
  }
  return session.kind === 'oracle' ? executeOracle(session, request) : executePostgres(session, request);
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
      session.lastActivityAt = new Date().toISOString();
      emitState(stateFor(session, 'connected'));
      return {
        executionId: request.executionId, status: 'ready', columns: state.columns, rows, hasMore,
        elapsedMs: performance.now() - state.startedAt, message: `${state.offset} rows fetched`,
        transactionState: transactionState(session),
      };
    }
    const { rows: values } = await readPostgresCursor(state.cursor, size);
    const rows = objectRows(values, state.columns, state.offset);
    state.offset += rows.length;
    const hasMore = rows.length === size;
    if (!hasMore) await closeCursor(request.executionId);
    session.lastActivityAt = new Date().toISOString();
    emitState(stateFor(session, 'connected'));
    return {
      executionId: request.executionId, status: 'ready', columns: state.columns, rows, hasMore,
      elapsedMs: performance.now() - state.startedAt, message: `${state.offset} rows fetched`,
      transactionState: transactionState(session),
    };
  } catch (error) {
    if (isConnectionError(error)) await invalidateSession(session, error);
    throw error;
  } finally {
    session.activeExecutionId = undefined;
  }
}

async function cancel(executionId: string): Promise<boolean> {
  const cursor = cursors.get(executionId);
  const session = cursor
    ? sessions.get(cursor.sessionKey)
    : [...sessions.values()].find((candidate) => candidate.activeExecutionId === executionId);
  if (!session) return false;
  if (session.kind === 'oracle') {
    await session.connection.break();
  } else {
    const control = new Client({
      host: session.profile.host, port: session.profile.port, database: session.profile.database,
      user: session.profile.username, password: session.profile.password,
      application_name: 'SQLExplorer cancel',
      connectionTimeoutMillis: 10_000,
    });
    await control.connect();
    try {
      const processId = (session.client as typeof session.client & { processID: number }).processID;
      await control.query('SELECT pg_cancel_backend($1)', [processId]);
    } finally {
      await control.end();
    }
  }
  await closeCursor(executionId, true);
  return true;
}

async function transaction(
  action: 'commit' | 'rollback',
  payload: { profile: ConnectionProfile; request: TransactionRequest },
): Promise<void> {
  const key = sessionKey(payload.profile.id, payload.request.documentId);
  const session = sessions.get(key);
  if (!session) throw Object.assign(new Error('Сессия этой вкладки не подключена'), {
    databaseError: { kind: 'transaction', message: 'Сессия этой вкладки не подключена', retryable: false },
  });
  await closeSessionCursors(session.sessionKey, true);
  try {
    if (session.kind === 'oracle') await session.connection[action]();
    else if (session.transactionOpen) {
      await session.client.query(action === 'commit' ? 'COMMIT' : 'ROLLBACK');
      session.transactionOpen = false;
    }
    session.changed = false;
    session.lastActivityAt = new Date().toISOString();
    emitState(stateFor(session, 'connected'));
  } catch (error) {
    if (isConnectionError(error)) await invalidateSession(session, error, true);
    throw error;
  }
}

async function testConnection(profile: ConnectionProfile): Promise<ConnectionTestResult> {
  if (initializationError) throw Object.assign(new Error(initializationError.message), { databaseError: initializationError });
  const startedAt = performance.now();
  if (profile.kind === 'oracle') {
    const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
    try {
      return {
        elapsedMs: performance.now() - startedAt,
        serverVersion: connection.oracleServerVersionString,
        driverMode: runtime.mode,
        oracleClientVersion: runtime.mode === 'thick' ? oracledb.oracleClientVersionString : undefined,
      };
    } finally {
      await connection.close();
    }
  }
  const client = new Client({
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer connection test',
    connectionTimeoutMillis: 10_000,
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
  const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
  try {
    const [objectResult, columnResult] = await Promise.all([
      connection.execute<Record<string, unknown>>(
        `select object_name, object_type from user_objects
         where object_type in ('TABLE', 'VIEW', 'PACKAGE', 'SEQUENCE', 'SYNONYM', 'FUNCTION')
         order by object_type, object_name`,
        {}, { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
      connection.execute<Record<string, unknown>>(
        `select table_name, column_name, data_type, data_length, data_precision,
                data_scale, nullable, column_id from user_tab_columns
         order by table_name, column_id`,
        {}, { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
    ]);
    const columnsByObject = new Map<string, MetadataColumn[]>();
    for (const column of columnResult.rows ?? []) {
      const name = String(column.TABLE_NAME);
      const columns = columnsByObject.get(name) ?? [];
      columns.push({
        name: String(column.COLUMN_NAME), dataType: oracleType(column),
        nullable: column.NULLABLE === 'Y', position: Number(column.COLUMN_ID),
      });
      columnsByObject.set(name, columns);
    }
    const kindMap: Record<string, MetadataObject['kind']> = {
      TABLE: 'table', VIEW: 'view', PACKAGE: 'package', SEQUENCE: 'sequence',
      SYNONYM: 'synonym', FUNCTION: 'function',
    };
    const schema = profile.username.toUpperCase();
    return {
      connectionId: profile.id, schema, fetchedAt: new Date().toISOString(),
      objects: (objectResult.rows ?? []).map((object) => {
        const name = String(object.OBJECT_NAME);
        return {
          schema, name, kind: kindMap[String(object.OBJECT_TYPE)] ?? 'table',
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
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer metadata',
    connectionTimeoutMillis: 10_000,
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
          schema: row.table_schema, name: row.object_name,
          kind: row.object_type === 'VIEW' ? 'view' : 'table', columns: [],
        };
        objects.set(key, object);
      }
      if (row.column_name && row.data_type && row.ordinal_position) {
        object.columns?.push({
          name: row.column_name, dataType: row.data_type,
          nullable: row.is_nullable === 'YES', position: row.ordinal_position,
        });
      }
    }
    return {
      connectionId: profile.id, schema: 'public', fetchedAt: new Date().toISOString(),
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
  await Promise.all([...cursors.keys()].map((executionId) => closeCursor(executionId)));
  await Promise.all([...sessions.values()].map((session) => closeSession(session, true).catch(() => undefined)));
  sessions.clear();
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case 'connect': return connect(request.payload as { profile: ConnectionProfile; request: SessionRequest });
    case 'disconnect': return disconnect(request.payload as { profile: ConnectionProfile; request: SessionRequest });
    case 'reconnect': return reconnect(request.payload as { profile: ConnectionProfile; request: SessionRequest });
    case 'execute': return execute(request.payload as { profile: ConnectionProfile; request: ExecuteRequest });
    case 'fetchMore': return fetchMore(request.payload as FetchMoreRequest);
    case 'cancel': return cancel((request.payload as { executionId: string }).executionId);
    case 'commit': return transaction('commit', request.payload as { profile: ConnectionProfile; request: TransactionRequest });
    case 'rollback': return transaction('rollback', request.payload as { profile: ConnectionProfile; request: TransactionRequest });
    case 'testConnection': return testConnection((request.payload as { profile: ConnectionProfile }).profile);
    case 'refreshMetadata': return refreshMetadata((request.payload as { profile: ConnectionProfile }).profile);
    case 'listTnsAliases': return oracledb.getNetworkServiceNames((request.payload as { configDir: string }).configDir);
    case 'close': return closeAll();
    default: throw new Error(`Unsupported database worker method: ${String(request.method)}`);
  }
}

workerPort.on('message', (event) => {
  const request = event.data as WorkerRequest;
  void dispatch(request).then((result) => {
    const response: WorkerResponse = { type: 'response', id: request.id, result };
    workerPort.postMessage(response);
  }).catch((error: unknown) => {
    const value = error instanceof Error ? error : new Error(String(error));
    const attached = error && typeof error === 'object' && 'databaseError' in error
      ? error.databaseError as DatabaseErrorInfo
      : databaseError(error);
    const response: WorkerResponse = {
      type: 'response', id: request.id,
      error: { ...attached, stack: value.stack },
    };
    workerPort.postMessage(response);
  });
});
