import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import oracledb from 'oracledb';
import type { Lob as OracleLob } from 'oracledb';
import pg from 'pg';
import Cursor from 'pg-cursor';
import type {
  BindValue,
  CatalogColumn,
  CatalogObjectKind,
  CatalogObjectPage,
  CatalogObjectQuery,
  CatalogOverview,
  CellValue,
  ConnectionProfile,
  ConnectionTestResult,
  DatabaseErrorInfo,
  DatabaseRuntimeConfiguration,
  ExecuteRequest,
  FetchMoreRequest,
  LobBudgetDecision,
  LobBudgetRequest,
  LobCellValue,
  LobChunkResult,
  LobProgress,
  LobReadRequest,
  LobSaveRequest,
  LobSaveResult,
  LobSubtype,
  QueryColumn,
  QueryPage,
  QueryRow,
  SessionContextResult,
  SessionRequest,
  SessionState,
  SetSessionSchemaRequest,
  TransactionRequest,
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
} from '../shared/contracts';
import {
  LOB_BUDGET_INITIAL_BYTES,
  LOB_BUDGET_RESPONSE_TIMEOUT_MS,
  LOB_BUDGET_STEP_BYTES,
  LOB_INLINE_TEXT_LIMIT,
  LOB_SAVE_CHUNK_BYTES,
  adjustTextChunkEnd,
  isBinarySubtype,
} from '../shared/lob';
import {
  type BindPrimitive,
  type SqlParameterOccurrence,
  extractSqlParameters,
  parseBindValue,
  rewritePostgresSql,
  uniqueSqlParameters,
} from '../shared/sql-binds';

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
  exhausted: boolean;
  kind: 'oracle';
  lobSubtypes: Array<LobSubtype | undefined>;
  lobs: LobStore;
  offset: number;
  resultSet: oracledb.ResultSet<unknown[]>;
  sessionKey: string;
  startedAt: number;
}

interface PostgresCursorState {
  columns: QueryColumn[];
  cursor: Cursor<Record<string, unknown>>;
  exhausted: boolean;
  kind: 'postgres';
  lobs: LobStore;
  offset: number;
  sessionKey: string;
  startedAt: number;
}

type CursorState = OracleCursorState | PostgresCursorState;

interface StoredOracleLob {
  kind: 'oracle';
  lob: OracleLob;
  size: number | null;
  sizeUnit: 'bytes' | 'chars';
  subtype: LobSubtype;
}

interface StoredValueLob {
  data: Buffer | string;
  kind: 'value';
  size: number;
  sizeUnit: 'bytes' | 'chars';
  subtype: LobSubtype;
}

type StoredLob = StoredOracleLob | StoredValueLob;

interface LobStore {
  budgetCap: number;
  budgetUsed: number;
  items: Map<string, StoredLob>;
  pendingBudget: Set<string>;
}

function createLobStore(): LobStore {
  return {
    budgetCap: budgetInitial,
    budgetUsed: 0,
    items: new Map(),
    pendingBudget: new Set(),
  };
}

function lobKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

const sessions = new Map<string, DatabaseSession>();
const cursors = new Map<string, CursorState>();

interface BudgetWaiter {
  resolve(allow: boolean): void;
  store: LobStore;
  timer: NodeJS.Timeout;
}

interface LobSaveTask {
  cancelled: boolean;
  executionId: string;
  filePath: string;
  operationId: string;
  stream?: fs.WriteStream;
}

const budgetWaiters = new Map<string, BudgetWaiter>();
const lobSaves = new Map<string, LobSaveTask>();

const budgetWaiterTimeoutMs = Number(process.env.SQLX_LOB_BUDGET_TIMEOUT_MS);
const budgetEnvStep = Number(process.env.SQLX_LOB_BUDGET_STEP_BYTES);
const budgetEnvInitial = Number(process.env.SQLX_LOB_BUDGET_BYTES);
const budgetInitial = Number.isFinite(budgetEnvInitial) && budgetEnvInitial >= 0
  ? budgetEnvInitial
  : LOB_BUDGET_INITIAL_BYTES;
const budgetStep = Number.isFinite(budgetEnvStep) && budgetEnvStep >= 0
  ? budgetEnvStep
  : LOB_BUDGET_STEP_BYTES;

function emitLobProgress(progress: LobProgress): void {
  const event: WorkerEvent = { type: 'event', event: 'lob-progress', payload: progress };
  workerPort.postMessage(event);
}

async function requestBudget(
  executionId: string,
  store: LobStore,
  requiredBytes: number,
): Promise<boolean> {
  const requestId = randomUUID();
  store.pendingBudget.add(requestId);
  const request: LobBudgetRequest = {
    requestId,
    executionId,
    requiredBytes,
    usedBytes: store.budgetUsed,
    capBytes: store.budgetCap,
  };
  const event: WorkerEvent = { type: 'event', event: 'lob-budget', payload: request };
  workerPort.postMessage(event);
  const allowed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      budgetWaiters.delete(requestId);
      resolve(false);
    }, Number.isFinite(budgetWaiterTimeoutMs) && budgetWaiterTimeoutMs > 0
      ? budgetWaiterTimeoutMs
      : LOB_BUDGET_RESPONSE_TIMEOUT_MS);
    timer.unref();
    budgetWaiters.set(requestId, { resolve, store, timer });
  });
  store.pendingBudget.delete(requestId);
  if (allowed) store.budgetCap += budgetStep;
  return allowed;
}

function confirmLobBudget(decision: LobBudgetDecision): void {
  const waiter = budgetWaiters.get(decision.requestId);
  if (!waiter) return;
  budgetWaiters.delete(decision.requestId);
  clearTimeout(waiter.timer);
  waiter.resolve(decision.allow);
}

function cancelStoreBudget(store: LobStore): void {
  for (const requestId of [...store.pendingBudget]) {
    const waiter = budgetWaiters.get(requestId);
    store.pendingBudget.delete(requestId);
    if (!waiter) continue;
    budgetWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
}

function cancelLobSaveTask(task: LobSaveTask): void {
  task.cancelled = true;
  try { task.stream?.destroy(); } catch { /* already closed */ }
}

function cancelLobSavesForExecution(executionId: string): void {
  for (const task of [...lobSaves.values()]) {
    if (task.executionId === executionId) cancelLobSaveTask(task);
  }
}

function cancelLobSave(operationId: string): boolean {
  const task = lobSaves.get(operationId);
  if (!task) return false;
  cancelLobSaveTask(task);
  return true;
}

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

function bindError(message: string): Error {
  return Object.assign(new Error(message), {
    databaseError: { kind: 'bind', message, retryable: false } satisfies DatabaseErrorInfo,
  });
}

function convertBindValues(
  occurrences: SqlParameterOccurrence[],
  parameters: Record<string, BindValue> | undefined,
): Map<string, BindPrimitive> {
  const provided = parameters ?? {};
  for (const occurrence of occurrences) {
    if (!(occurrence.key in provided)) {
      throw bindError(`Не задано значение параметра ${occurrence.name}`);
    }
  }
  const expected = new Set(occurrences.map((occurrence) => occurrence.key));
  const extras = Object.keys(provided).filter((key) => !expected.has(key));
  if (extras.length) {
    throw bindError(`Неизвестные значения параметров: ${extras.map((key) => `:${key}`).join(', ')}`);
  }
  const converted = new Map<string, BindPrimitive>();
  for (const occurrence of occurrences) {
    const input = provided[occurrence.key];
    const parsed = parseBindValue(input.type, input.value);
    if (!parsed.ok) throw bindError(`${occurrence.name}: ${parsed.message}`);
    converted.set(occurrence.key, parsed.value);
  }
  return converted;
}

function oracleBinds(
  sql: string,
  parameters: Record<string, BindValue> | undefined,
): Record<string, string | number | Date | null> {
  const extraction = extractSqlParameters(sql, 'oracle');
  if (extraction.error) throw bindError(extraction.error);
  const order = uniqueSqlParameters(extraction.occurrences);
  const converted = convertBindValues(order, parameters);
  const binds: Record<string, string | number | Date | null> = {};
  for (const occurrence of order) {
    binds[occurrence.key] = converted.get(occurrence.key) ?? null;
  }
  return binds;
}

function postgresBindPlan(
  sql: string,
  parameters: Record<string, BindValue> | undefined,
): { sql: string; values: Array<string | number | null> } {
  const rewrite = rewritePostgresSql(sql);
  if ('error' in rewrite) throw bindError(rewrite.error);
  const converted = convertBindValues(rewrite.order, parameters);
  const values = rewrite.order.map((occurrence) => {
    const value = converted.get(occurrence.key);
    if (value instanceof Date) return (parameters ?? {})[occurrence.key].value.trim();
    if (value === null || typeof value === 'string' || typeof value === 'number') return value;
    return String(value);
  });
  return { sql: rewrite.sql, values };
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

function serializePrimitive(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `base64:${value.toString('base64')}`;
  if (value instanceof Uint8Array) return `base64:${Buffer.from(value).toString('base64')}`;
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function oracleSubtype(column: oracledb.Metadata<unknown[]>): LobSubtype | undefined {
  switch (column.dbTypeName) {
    case 'CLOB': return 'CLOB';
    case 'NCLOB': return 'NCLOB';
    case 'BLOB': return 'BLOB';
    case 'BFILE': return 'BFILE';
    default: return undefined;
  }
}

function isOracleLob(value: unknown): value is OracleLob {
  return typeof value === 'object' && value !== null
    && typeof (value as { getData?: unknown }).getData === 'function'
    && typeof (value as { pipe?: unknown }).pipe === 'function'
    && typeof (value as { setEncoding?: unknown }).setEncoding === 'function';
}

function lobSubtypeOf(lob: OracleLob): LobSubtype {
  if (lob.type === oracledb.CLOB) return 'CLOB';
  if (lob.type === oracledb.NCLOB) return 'NCLOB';
  if (lob.type === oracledb.BLOB) return 'BLOB';
  return 'BFILE';
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

function oracleRows(
  rows: unknown[][],
  subtypes: Array<LobSubtype | undefined>,
  offset: number,
  store: LobStore,
): QueryRow[] {
  return rows.map((row, rowIndex) => {
    const rowNumber = offset + rowIndex + 1;
    return {
      index: rowNumber,
      cells: row.map((value, columnIndex) => {
        if (isOracleLob(value)) {
          const subtype = subtypes[columnIndex] ?? lobSubtypeOf(value);
          let size: number | null;
          try {
            size = typeof value.length === 'number' ? value.length : null;
          } catch {
            size = null;
          }
          const sizeUnit = isBinarySubtype(subtype) ? 'bytes' : 'chars';
          store.items.set(lobKey(rowNumber, columnIndex), { kind: 'oracle', lob: value, subtype, size, sizeUnit });
          const marker: LobCellValue = { kind: 'lob', subtype, size, sizeUnit, available: true };
          return marker;
        }
        return serializePrimitive(value);
      }),
    };
  });
}

async function storeValueCell(
  store: LobStore,
  executionId: string,
  rowIndex: number,
  columnIndex: number,
  subtype: LobSubtype,
  data: Buffer | string,
  sizeUnit: 'bytes' | 'chars',
): Promise<LobCellValue> {
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  const size = sizeUnit === 'bytes' ? bytes : data.length;
  let attempts = 0;
  while (store.budgetUsed + bytes > store.budgetCap && attempts < 64) {
    attempts += 1;
    const allowed = await requestBudget(executionId, store, bytes);
    if (!allowed) {
      return { kind: 'lob', subtype, size, sizeUnit, available: false, note: 'budget' };
    }
  }
  if (store.budgetUsed + bytes > store.budgetCap) {
    return { kind: 'lob', subtype, size, sizeUnit, available: false, note: 'budget' };
  }
  store.items.set(lobKey(rowIndex, columnIndex), { kind: 'value', data, subtype, size, sizeUnit });
  store.budgetUsed += bytes;
  return { kind: 'lob', subtype, size, sizeUnit, available: true };
}

async function serializePostgresCell(
  value: unknown,
  rowIndex: number,
  columnIndex: number,
  store: LobStore,
  executionId: string,
): Promise<CellValue> {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return storeValueCell(store, executionId, rowIndex, columnIndex, 'BYTEA', Buffer.from(value), 'bytes');
  }
  if (typeof value === 'string') {
    if (value.length <= LOB_INLINE_TEXT_LIMIT) return value;
    return storeValueCell(store, executionId, rowIndex, columnIndex, 'TEXT', value, 'chars');
  }
  const primitive = serializePrimitive(value);
  if (typeof primitive === 'string' && primitive.length > LOB_INLINE_TEXT_LIMIT) {
    return storeValueCell(store, executionId, rowIndex, columnIndex, 'TEXT', primitive, 'chars');
  }
  return primitive;
}

async function postgresRows(
  rows: Record<string, unknown>[],
  columns: QueryColumn[],
  offset: number,
  store: LobStore,
  executionId: string,
): Promise<QueryRow[]> {
  const result: QueryRow[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells: CellValue[] = [];
    const rowNumber = offset + rowIndex + 1;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      cells.push(await serializePostgresCell(
        rows[rowIndex][columns[columnIndex].name],
        rowNumber,
        columnIndex,
        store,
        executionId,
      ));
    }
    result.push({ index: rowNumber, cells });
  }
  return result;
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

function releaseLobStore(store: LobStore, executionId: string): void {
  cancelStoreBudget(store);
  cancelLobSavesForExecution(executionId);
  const locators = [...store.items.values()]
    .filter((item): item is StoredOracleLob => item.kind === 'oracle');
  store.items.clear();
  store.budgetUsed = 0;
  for (const item of locators) {
    try { item.lob.destroy(); } catch { /* already closed */ }
  }
}

async function closeCursor(executionId: string, suppressErrors = true): Promise<void> {
  const state = cursors.get(executionId);
  if (!state) return;
  cursors.delete(executionId);
  releaseLobStore(state.lobs, executionId);
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

async function createSession(
  profile: ConnectionProfile,
  documentId: string,
  schema?: string,
): Promise<DatabaseSession> {
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
      if (schema) await applySessionSchema(created, schema);
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
    if (schema) await applySessionSchema(created, schema);
    emitState(stateFor(created, 'connected'));
    return created;
  } catch (error) {
    const info = databaseError(error, 'connection');
    emitState({ ...connectingState(profile, documentId), status: 'error', error: info });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { databaseError: info });
  }
}

async function connect(payload: { profile: ConnectionProfile; request: SessionRequest }): Promise<SessionState> {
  const session = await createSession(payload.profile, payload.request.documentId, payload.request.schema);
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
    const binds = oracleBinds(request.sql, request.parameters);
    const result = await session.connection.execute<unknown[]>(
      oracleDriverSql(request.sql),
      binds,
      { autoCommit: false, fetchArraySize: size, outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true },
    );
    session.lastActivityAt = new Date().toISOString();
    if (result.resultSet && result.metaData) {
      const columns = oracleColumns(result.metaData);
      const lobSubtypes = result.metaData.map((column) => oracleSubtype(column));
      const values = await result.resultSet.getRows(size);
      const hasMore = values.length === size;
      const store = createLobStore();
      const rows = oracleRows(values, lobSubtypes, 0, store);
      if (hasMore || store.items.size > 0) {
        cursors.set(request.executionId, {
          kind: 'oracle', resultSet: result.resultSet, columns, offset: values.length,
          sessionKey: session.sessionKey, startedAt, lobs: store, exhausted: !hasMore, lobSubtypes,
        });
      } else {
        await result.resultSet.close();
      }
      emitState(stateFor(session, 'connected'));
      return {
        executionId: request.executionId, status: 'ready', columns, rows, hasMore,
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
    const plan = postgresBindPlan(request.sql, request.parameters);
    await ensurePostgresTransaction(session);
    const cursor = session.client.query(new Cursor<Record<string, unknown>>(ensureSql(plan.sql), plan.values));
    const { rows: values, result } = await readPostgresCursor(cursor, size);
    const columns = postgresColumns(result.fields);
    const hasMore = columns.length > 0 && values.length === size;
    const store = createLobStore();
    const rows = columns.length
      ? await postgresRows(values, columns, 0, store, request.executionId)
      : [];
    if (hasMore || store.items.size > 0) {
      cursors.set(request.executionId, {
        kind: 'postgres', cursor, columns, offset: values.length,
        sessionKey: session.sessionKey, startedAt, lobs: store, exhausted: !hasMore,
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
      rows, hasMore, rowsAffected,
      elapsedMs: performance.now() - startedAt,
      message: columns.length
        ? `${rows.length} rows fetched`
        : `${result.command || command} completed${rowsAffected === undefined ? '' : ` · ${rowsAffected} affected`}`,
      transactionState: transactionState(session),
    };
  } catch (error) {
    if (isConnectionError(error)) {
      await invalidateSession(session, error, session.changed || changesTransaction(request.sql, 'postgres'));
    } else if (session.transactionOpen && databaseError(error).kind !== 'bind') {
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
  const session = await createSession(profile, request.documentId, request.schema);
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
  if (state.exhausted) throw new Error('The result cursor has already been fully fetched');
  const size = pageSize(request.pageSize);
  const session = sessions.get(state.sessionKey);
  if (!session) throw new Error('The database session is no longer available');
  session.activeExecutionId = request.executionId;
  try {
    if (state.kind === 'oracle') {
      const values = await state.resultSet.getRows(size);
      const rows = oracleRows(values, state.lobSubtypes, state.offset, state.lobs);
      state.offset += rows.length;
      const hasMore = rows.length === size;
      if (!hasMore) {
        state.exhausted = true;
        if (state.lobs.items.size === 0) await closeCursor(request.executionId);
      }
      session.lastActivityAt = new Date().toISOString();
      emitState(stateFor(session, 'connected'));
      return {
        executionId: request.executionId, status: 'ready', columns: state.columns, rows, hasMore,
        elapsedMs: performance.now() - state.startedAt, message: `${state.offset} rows fetched`,
        transactionState: transactionState(session),
      };
    }
    const { rows: values } = await readPostgresCursor(state.cursor, size);
    const rows = await postgresRows(values, state.columns, state.offset, state.lobs, request.executionId);
    state.offset += rows.length;
    const hasMore = rows.length === size;
    if (!hasMore) {
      state.exhausted = true;
      if (state.lobs.items.size === 0) await closeCursor(request.executionId);
    }
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

const ORACLE_KIND_MAP: Record<string, CatalogObjectKind> = {
  TABLE: 'table',
  VIEW: 'view',
  'MATERIALIZED VIEW': 'matview',
  PACKAGE: 'package',
  SEQUENCE: 'sequence',
  SYNONYM: 'synonym',
  FUNCTION: 'function',
  PROCEDURE: 'procedure',
  TYPE: 'type',
};
const ORACLE_TYPES = Object.keys(ORACLE_KIND_MAP);
const ORACLE_KIND_TO_TYPES: Record<CatalogObjectKind, string[]> = {
  table: ['TABLE'],
  view: ['VIEW'],
  matview: ['MATERIALIZED VIEW'],
  package: ['PACKAGE'],
  sequence: ['SEQUENCE'],
  synonym: ['SYNONYM'],
  function: ['FUNCTION'],
  procedure: ['PROCEDURE'],
  type: ['TYPE'],
};

function oracleTypeList(kinds?: CatalogObjectKind[]): string {
  const types = kinds?.length ? kinds.flatMap((kind) => ORACLE_KIND_TO_TYPES[kind]) : ORACLE_TYPES;
  return types.length ? types.map((type) => `'${type}'`).join(', ') : `''`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function parsePostgresSearchPath(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.startsWith('"') && entry.endsWith('"')
      ? entry.slice(1, -1).replaceAll('""', '"')
      : entry);
}

async function applySessionSchema(session: DatabaseSession, schema: string): Promise<void> {
  if (!schema) return;
  if (session.kind === 'oracle') {
    const quoted = `"${schema.replaceAll('"', '""')}"`;
    await session.connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${quoted}`);
  } else {
    await session.client.query('select pg_catalog.set_config($1, $2, false)', ['search_path', schema]);
  }
}

async function oracleOverview(profile: ConnectionProfile): Promise<CatalogOverview> {
  const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
  try {
    const [userResult, contextResult] = await Promise.all([
      connection.execute<Record<string, unknown>>(
        'select username from all_users order by username', {}, { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
      connection.execute<Record<string, unknown>>(
        `select sys_context('USERENV', 'CURRENT_USER') as current_user,
                sys_context('USERENV', 'CURRENT_SCHEMA') as current_schema
         from dual`,
        {}, { outFormat: oracledb.OUT_FORMAT_OBJECT },
      ),
    ]);
    const context = contextResult.rows?.[0];
    return {
      userName: stringValue(context?.CURRENT_USER, profile.username.toUpperCase()),
      currentSchema: stringValue(context?.CURRENT_SCHEMA, profile.username.toUpperCase()),
      searchPath: [],
      schemas: (userResult.rows ?? []).map((row) => String(row.USERNAME)),
    };
  } finally {
    await connection.close();
  }
}

async function oracleCountSchemaObjects(profile: ConnectionProfile, schema: string): Promise<number> {
  const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
  try {
    const result = await connection.execute<Record<string, unknown>>(
      `select count(*) as object_count from all_objects
       where owner = :owner and object_type in (${oracleTypeList()})`,
      { owner: schema },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return Number(result.rows?.[0]?.OBJECT_COUNT ?? 0);
  } finally {
    await connection.close();
  }
}

function oracleObjectPage(
  rows: Record<string, unknown>[],
  limit: number,
  schema: string,
): CatalogObjectPage {
  const hasMore = rows.length > limit;
  return {
    hasMore,
    objects: rows.slice(0, limit).map((row) => ({
      schema,
      name: String(row.OBJECT_NAME),
      kind: ORACLE_KIND_MAP[String(row.OBJECT_TYPE)] ?? 'table',
    })),
  };
}

async function oracleListObjects(
  profile: ConnectionProfile,
  query: CatalogObjectQuery,
): Promise<CatalogObjectPage> {
  const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
  try {
    const limit = Math.max(1, Math.min(5_000, Math.trunc(query.limit)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const rawPrefix = query.prefix ?? '';
    const prefix = query.caseSensitive ? rawPrefix : rawPrefix.toUpperCase();
    const escaped = escapeLikePattern(prefix);
    const pattern = !prefix ? '%' : query.substring ? `%${escaped}%` : `${escaped}%`;
    if (query.schema.toUpperCase() === 'PUBLIC') {
      if (query.kinds?.length && !query.kinds.includes('synonym')) return { hasMore: false, objects: [] };
      const result = await connection.execute<Record<string, unknown>>(
        `select synonym_name as object_name, 'SYNONYM' as object_type
         from all_synonyms
         where owner = 'PUBLIC' and synonym_name like :pattern escape '\\'
         order by synonym_name
         offset :offset rows fetch next :limit rows only`,
        { pattern, offset, limit: limit + 1 },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return oracleObjectPage(result.rows ?? [], limit, query.schema);
    }
    const result = await connection.execute<Record<string, unknown>>(
      `select object_name, object_type from all_objects
       where owner = :owner and object_type in (${oracleTypeList(query.kinds)})
         and object_name like :pattern escape '\\'
       order by object_name
       offset :offset rows fetch next :limit rows only`,
      { owner: query.schema, pattern, offset, limit: limit + 1 },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return oracleObjectPage(result.rows ?? [], limit, query.schema);
  } finally {
    await connection.close();
  }
}

async function oracleListColumns(
  profile: ConnectionProfile,
  schema: string,
  object: string,
): Promise<CatalogColumn[]> {
  const connection = await oracledb.getConnection(oracleConnectionAttributes(profile));
  try {
    const read = async (owner: string, table: string): Promise<Record<string, unknown>[]> => (
      await connection.execute<Record<string, unknown>>(
        `select column_name, data_type, data_length, data_precision, data_scale, nullable, column_id
         from all_tab_columns where owner = :owner and table_name = :object order by column_id`,
        { owner, object: table },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      )
    ).rows ?? [];
    let rows = await read(schema, object);
    if (!rows.length) {
      const synonyms = (await connection.execute<Record<string, unknown>>(
        `select table_owner, table_name, db_link from all_synonyms
         where synonym_name = :object and owner in (:owner, 'PUBLIC')
         order by case when owner = :owner then 0 else 1 end`,
        { owner: schema, object },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      )).rows ?? [];
      const target = synonyms.find((row) => row.TABLE_OWNER && !row.DB_LINK);
      if (target) rows = await read(String(target.TABLE_OWNER), String(target.TABLE_NAME));
    }
    return rows.map((column) => ({
      name: String(column.COLUMN_NAME),
      dataType: oracleType(column),
      nullable: column.NULLABLE === 'Y',
      position: Number(column.COLUMN_ID),
    }));
  } finally {
    await connection.close();
  }
}

async function postgresOverview(profile: ConnectionProfile): Promise<CatalogOverview> {
  const client = new Client({
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer catalog overview',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const [schemaResult, contextResult] = await Promise.all([
      client.query<{ nspname: string }>(
        `select nspname from pg_catalog.pg_namespace
         where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
           and has_schema_privilege(oid, 'USAGE')
         order by nspname`,
      ),
      client.query<{ current_schema: string | null; current_user: string; search_path: string }>(
        `select current_user, current_schema() as current_schema, current_setting('search_path') as search_path`,
      ),
    ]);
    const context = contextResult.rows[0];
    return {
      userName: context?.current_user ?? profile.username,
      currentSchema: context?.current_schema ?? 'public',
      searchPath: parsePostgresSearchPath(context?.search_path ?? ''),
      schemas: schemaResult.rows.map((row) => row.nspname),
    };
  } finally {
    await client.end();
  }
}

async function postgresCountSchemaObjects(profile: ConnectionProfile, schema: string): Promise<number> {
  const client = new Client({
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer catalog count',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query<{ object_count: string }>(
      `select
        (select count(*) from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
           and (case when c.relkind = 'S'
                     then has_sequence_privilege(c.oid, 'USAGE,SELECT,UPDATE')
                     else has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER') end))
        + (select count(*) from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = $1 and has_function_privilege(p.oid, 'EXECUTE')) as object_count`,
      [schema],
    );
    return Number(result.rows[0]?.object_count ?? 0);
  } finally {
    await client.end();
  }
}

async function postgresListObjects(
  profile: ConnectionProfile,
  query: CatalogObjectQuery,
): Promise<CatalogObjectPage> {
  const client = new Client({
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer catalog',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const limit = Math.max(1, Math.min(5_000, Math.trunc(query.limit)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const rawPrefix = query.prefix ?? '';
    const prefix = query.caseSensitive ? rawPrefix : rawPrefix.toLocaleLowerCase();
    const escaped = escapeLikePattern(prefix);
    const pattern = !prefix ? '%' : query.substring ? `%${escaped}%` : `${escaped}%`;
    const kinds = query.kinds?.length ? new Set(query.kinds) : undefined;
    const relationKinds = kinds
      ? [...kinds].flatMap((kind) => kind === 'table' ? ['r', 'p', 'f']
        : kind === 'view' ? ['v'] : kind === 'matview' ? ['m'] : kind === 'sequence' ? ['S'] : [])
      : ['r', 'p', 'v', 'm', 'S', 'f'];
    const branches: string[] = [];
    if (relationKinds.length) {
      branches.push(`
        select c.relname as name,
               case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                    when 'm' then 'matview' when 'S' then 'sequence' when 'f' then 'table' end as kind
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in (${relationKinds.map((kind) => `'${kind}'`).join(', ')})
          and c.relname like $2 escape '\\'
          and (case when c.relkind = 'S'
                    then has_sequence_privilege(c.oid, 'USAGE,SELECT,UPDATE')
                    else has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER') end)
      `);
    }
    if (!kinds || kinds.has('function') || kinds.has('procedure')) {
      branches.push(`
        select p.proname as name, 'function' as kind
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname like $2 escape '\\'
          and has_function_privilege(p.oid, 'EXECUTE')
      `);
    }
    if (!branches.length) return { hasMore: false, objects: [] };
    const result = await client.query<{ kind: string; name: string }>(
      `select name, kind from (${branches.join(' union all ')}) objects
       order by name, kind
       limit $3 offset $4`,
      [query.schema, pattern, limit + 1, offset],
    );
    const hasMore = result.rows.length > limit;
    return {
      hasMore,
      objects: result.rows.slice(0, limit).map((row) => ({
        schema: query.schema,
        name: row.name,
        kind: row.kind as CatalogObjectKind,
      })),
    };
  } finally {
    await client.end();
  }
}

async function postgresListColumns(
  profile: ConnectionProfile,
  schema: string,
  object: string,
): Promise<CatalogColumn[]> {
  const client = new Client({
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.username, password: profile.password,
    application_name: 'SQLExplorer catalog columns',
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query<{
      data_type: string;
      name: string;
      nullable: boolean;
      position: number;
    }>(
      `select a.attname as name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
              not a.attnotnull as nullable,
              a.attnum as position
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
       order by a.attnum`,
      [schema, object],
    );
    return result.rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: row.nullable,
      position: Number(row.position),
    }));
  } finally {
    await client.end();
  }
}

async function catalogOverview(profile: ConnectionProfile): Promise<CatalogOverview> {
  return profile.kind === 'oracle' ? oracleOverview(profile) : postgresOverview(profile);
}

async function countSchemaObjects(profile: ConnectionProfile, schema: string): Promise<number> {
  return profile.kind === 'oracle'
    ? oracleCountSchemaObjects(profile, schema)
    : postgresCountSchemaObjects(profile, schema);
}

async function listObjects(
  profile: ConnectionProfile,
  query: CatalogObjectQuery,
): Promise<CatalogObjectPage> {
  return profile.kind === 'oracle'
    ? oracleListObjects(profile, query)
    : postgresListObjects(profile, query);
}

async function listColumns(
  profile: ConnectionProfile,
  schema: string,
  object: string,
): Promise<CatalogColumn[]> {
  return profile.kind === 'oracle'
    ? oracleListColumns(profile, schema, object)
    : postgresListColumns(profile, schema, object);
}

async function sessionContext(
  profile: ConnectionProfile,
  request: Pick<SessionRequest, 'connectionId' | 'documentId'>,
): Promise<SessionContextResult | undefined> {
  const session = sessions.get(sessionKey(profile.id, request.documentId));
  if (!session) return undefined;
  if (session.kind === 'oracle') {
    const result = await session.connection.execute<Record<string, unknown>>(
      `select sys_context('USERENV', 'CURRENT_USER') as current_user,
              sys_context('USERENV', 'CURRENT_SCHEMA') as current_schema
       from dual`,
      {}, { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = result.rows?.[0];
    return {
      userName: stringValue(row?.CURRENT_USER, session.profile.username.toUpperCase()),
      currentSchema: stringValue(row?.CURRENT_SCHEMA, session.profile.username.toUpperCase()),
      searchPath: [],
    };
  }
  const result = await session.client.query<{
    current_schema: string | null;
    current_user: string;
    search_path: string;
  }>(`select current_user, current_schema() as current_schema, current_setting('search_path') as search_path`);
  const row = result.rows[0];
  return {
    userName: row?.current_user ?? session.profile.username,
    currentSchema: row?.current_schema ?? 'public',
    searchPath: parsePostgresSearchPath(row?.search_path ?? ''),
  };
}

async function setSessionSchema(
  profile: ConnectionProfile,
  request: SetSessionSchemaRequest,
): Promise<SessionContextResult | undefined> {
  const session = sessions.get(sessionKey(profile.id, request.documentId));
  if (!session) return undefined;
  await applySessionSchema(session, request.schema);
  return sessionContext(profile, request);
}

function readValueLob(item: StoredValueLob, offset: number, length: number): LobChunkResult {
  if (typeof item.data === 'string') {
    const end = adjustTextChunkEnd(item.data, Math.min(item.data.length, offset + Math.max(1, length)));
    const chunk = item.data.slice(offset, end);
    const nextOffset = offset + chunk.length;
    return {
      data: chunk, encoding: 'utf8', eof: nextOffset >= item.data.length,
      nextOffset, offset, size: item.size, sizeUnit: item.sizeUnit, subtype: item.subtype,
    };
  }
  const end = Math.min(item.data.byteLength, offset + Math.max(1, length));
  const chunk = item.data.subarray(offset, end);
  const nextOffset = offset + chunk.byteLength;
  return {
    data: chunk.toString('base64'), encoding: 'base64', eof: nextOffset >= item.data.byteLength,
    nextOffset, offset, size: item.size, sizeUnit: item.sizeUnit, subtype: item.subtype,
  };
}

async function readOracleLob(
  item: StoredOracleLob,
  offset: number,
  length: number,
): Promise<LobChunkResult> {
  const binary = isBinarySubtype(item.subtype);
  const amount = Math.max(1, length);
  const value = await item.lob.getData(offset + 1, amount);
  if (value === null || value === undefined) {
    return {
      data: '', encoding: binary ? 'base64' : 'utf8', eof: true,
      nextOffset: offset, offset, size: item.size, sizeUnit: item.sizeUnit, subtype: item.subtype,
    };
  }
  if (binary) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const nextOffset = offset + buffer.byteLength;
    return {
      data: buffer.toString('base64'), encoding: 'base64',
      eof: item.size !== null ? nextOffset >= item.size : buffer.byteLength < amount,
      nextOffset, offset, size: item.size, sizeUnit: item.sizeUnit, subtype: item.subtype,
    };
  }
  let text = typeof value === 'string' ? value : value.toString('utf8');
  let nextOffset = offset + text.length;
  let eof = item.size !== null ? nextOffset >= item.size : text.length < amount;
  const lastCode = text.length ? text.charCodeAt(text.length - 1) : 0;
  if (!eof && text.length > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff) {
    const extra = await item.lob.getData(offset + text.length + 1, 1);
    if (typeof extra === 'string' && extra) {
      text += extra;
      nextOffset += extra.length;
      eof = item.size !== null ? nextOffset >= item.size : false;
    }
  }
  return {
    data: text, encoding: 'utf8', eof, nextOffset, offset,
    size: item.size, sizeUnit: item.sizeUnit, subtype: item.subtype,
  };
}

async function readLob(request: LobReadRequest): Promise<LobChunkResult> {
  const state = cursors.get(request.executionId);
  const item = state?.lobs.items.get(lobKey(request.rowIndex, request.columnIndex));
  if (!state || !item) {
    const message = 'Значение больше недоступно: результат запроса заменён или соединение закрыто';
    throw Object.assign(new Error(message), {
      databaseError: { kind: 'sql', message, retryable: false } satisfies DatabaseErrorInfo,
    });
  }
  const offset = Math.max(0, Math.trunc(request.offset));
  const length = Math.max(1, Math.trunc(request.length));
  return item.kind === 'oracle'
    ? readOracleLob(item, offset, length)
    : readValueLob(item, offset, length);
}

function writeStreamChunk(stream: fs.WriteStream, chunk: Buffer | string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function saveOracleLob(
  task: LobSaveTask,
  item: StoredOracleLob,
  meta: { columnIndex: number; rowIndex: number },
): Promise<LobSaveResult> {
  const chunkSize = 1024 * 1024;
  const stream = fs.createWriteStream(task.filePath);
  task.stream = stream;
  let offset = 0;
  let bytes = 0;
  let error: Error | undefined;
  try {
    while (!task.cancelled) {
      const remaining = item.size === null ? chunkSize : Math.min(chunkSize, item.size - offset);
      if (remaining <= 0) break;
      const value = await item.lob.getData(offset + 1, Math.max(1, remaining));
      if (value === null || value === undefined) break;
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
      if (buffer.byteLength === 0) break;
      await writeStreamChunk(stream, buffer);
      bytes = stream.bytesWritten;
      offset += typeof value === 'string' ? value.length : value.byteLength;
      emitLobProgress({
        operationId: task.operationId, executionId: task.executionId,
        rowIndex: meta.rowIndex, columnIndex: meta.columnIndex,
        bytesWritten: bytes, totalBytes: item.size, phase: 'running',
      });
      const unitLength = typeof value === 'string' ? value.length : value.byteLength;
      if (unitLength < remaining) break;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  if (task.cancelled) {
    stream.destroy();
    await fs.promises.rm(task.filePath, { force: true }).catch(() => undefined);
    emitLobProgress({
      operationId: task.operationId, executionId: task.executionId,
      rowIndex: meta.rowIndex, columnIndex: meta.columnIndex,
      bytesWritten: bytes, totalBytes: item.size, phase: 'cancelled',
    });
    return { status: 'cancelled' };
  }
  if (error) {
    stream.destroy();
    await fs.promises.rm(task.filePath, { force: true }).catch(() => undefined);
    emitLobProgress({
      operationId: task.operationId, executionId: task.executionId,
      rowIndex: meta.rowIndex, columnIndex: meta.columnIndex,
      bytesWritten: bytes, totalBytes: item.size, phase: 'error', error: error.message,
    });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.once('error', reject);
  });
  emitLobProgress({
    operationId: task.operationId, executionId: task.executionId,
    rowIndex: meta.rowIndex, columnIndex: meta.columnIndex,
    bytesWritten: bytes, totalBytes: item.size, phase: 'saved',
  });
  return { status: 'saved', filePath: task.filePath, bytes };
}

async function saveValueLob(
  task: LobSaveTask,
  item: StoredValueLob,
  meta: { columnIndex: number; rowIndex: number },
): Promise<LobSaveResult> {
  const { data } = item;
  const totalBytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  const stream = fs.createWriteStream(task.filePath);
  task.stream = stream;
  const emit = (phase: LobProgress['phase'], error?: string) => emitLobProgress({
    operationId: task.operationId, executionId: task.executionId,
    rowIndex: meta.rowIndex, columnIndex: meta.columnIndex,
    bytesWritten: stream.bytesWritten, totalBytes, phase, error,
  });
  try {
    if (typeof data === 'string') {
      for (let offset = 0; offset < data.length; offset += LOB_SAVE_CHUNK_BYTES) {
        if (task.cancelled) break;
        await writeStreamChunk(stream, data.slice(offset, Math.min(data.length, offset + LOB_SAVE_CHUNK_BYTES)));
        emit('running');
      }
    } else {
      for (let offset = 0; offset < data.byteLength; offset += LOB_SAVE_CHUNK_BYTES) {
        if (task.cancelled) break;
        await writeStreamChunk(stream, data.subarray(offset, Math.min(data.byteLength, offset + LOB_SAVE_CHUNK_BYTES)));
        emit('running');
      }
    }
    if (task.cancelled) {
      stream.destroy();
      await fs.promises.rm(task.filePath, { force: true }).catch(() => undefined);
      emit('cancelled');
      return { status: 'cancelled' };
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once('error', reject);
    });
    emit('saved');
    return { status: 'saved', filePath: task.filePath, bytes: totalBytes };
  } catch (error) {
    stream.destroy();
    await fs.promises.rm(task.filePath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    emit('error', message);
    throw error instanceof Error ? error : new Error(message);
  }
}

async function saveLob(
  payload: LobSaveRequest & { filePath: string; operationId: string },
): Promise<LobSaveResult> {
  const state = cursors.get(payload.executionId);
  const item = state?.lobs.items.get(lobKey(payload.rowIndex, payload.columnIndex));
  if (!state || !item) return { status: 'unavailable' };
  const task: LobSaveTask = {
    cancelled: false,
    executionId: payload.executionId,
    filePath: payload.filePath,
    operationId: payload.operationId,
  };
  lobSaves.set(task.operationId, task);
  const meta = { columnIndex: payload.columnIndex, rowIndex: payload.rowIndex };
  try {
    return item.kind === 'oracle'
      ? await saveOracleLob(task, item, meta)
      : await saveValueLob(task, item, meta);
  } finally {
    lobSaves.delete(task.operationId);
  }
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
    case 'catalogOverview': return catalogOverview((request.payload as { profile: ConnectionProfile }).profile);
    case 'countSchemaObjects': return countSchemaObjects(
      (request.payload as { profile: ConnectionProfile }).profile,
      (request.payload as { schema: string }).schema,
    );
    case 'listObjects': {
      const payload = request.payload as { profile: ConnectionProfile; query: CatalogObjectQuery };
      return listObjects(payload.profile, payload.query);
    }
    case 'listColumns': {
      const payload = request.payload as { object: string; profile: ConnectionProfile; schema: string };
      return listColumns(payload.profile, payload.schema, payload.object);
    }
    case 'sessionContext': {
      const payload = request.payload as { profile: ConnectionProfile; request: SessionRequest };
      return sessionContext(payload.profile, payload.request);
    }
    case 'setSessionSchema': {
      const payload = request.payload as { profile: ConnectionProfile; request: SetSessionSchemaRequest };
      return setSessionSchema(payload.profile, payload.request);
    }
    case 'listTnsAliases': return oracledb.getNetworkServiceNames((request.payload as { configDir: string }).configDir);
    case 'readLob': return readLob(request.payload as LobReadRequest);
    case 'saveLob': return saveLob(request.payload as LobSaveRequest & { filePath: string; operationId: string });
    case 'cancelLobSave': return cancelLobSave((request.payload as { operationId: string }).operationId);
    case 'confirmLobBudget': {
      confirmLobBudget(request.payload as LobBudgetDecision);
      return undefined;
    }
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
