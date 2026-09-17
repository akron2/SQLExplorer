import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import type {
  BindValue,
  ConnectionProfile,
  ExecuteRequest,
  QueryPage,
  SessionState,
} from '../shared/contracts';
import { isLobCellValue } from '../shared/lob';
import type { ConnectionRegistry } from './connection-registry';
import type { DatabaseRuntimeManager } from './database-runtime-manager';
import { ExcelExportSession } from './excel-export';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function collectLob(
  runtime: DatabaseRuntimeManager,
  request: { columnIndex: number; executionId: string; rowIndex: number },
): Promise<string> {
  let data = '';
  let offset = 0;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const chunk = await runtime.readLob({ ...request, offset, length: 65_536 });
    data += chunk.data;
    offset = chunk.nextOffset;
    if (chunk.eof) return data;
  }
  throw new Error('LOB chunk loop did not reach the end of the value');
}

async function collectLobBytes(
  runtime: DatabaseRuntimeManager,
  request: { columnIndex: number; executionId: string; rowIndex: number },
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const chunk = await runtime.readLob({ ...request, offset, length: 65_536 });
    parts.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.nextOffset;
    if (chunk.eof) return Buffer.concat(parts);
  }
  throw new Error('LOB chunk loop did not reach the end of the value');
}

async function verifyLobSupport(
  runtime: DatabaseRuntimeManager,
  oracle: ConnectionProfile,
  postgres: ConnectionProfile,
): Promise<void> {
  const oracleDocument = 'integration-oracle-lob';
  const postgresDocument = 'integration-postgres-lob';
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlexplorer-lob-'));

  await execute(runtime, oracle, oracleDocument, `begin
    execute immediate 'drop table sqlx_lob_probe purge';
  exception when others then null;
  end;`);
  await execute(runtime, oracle, oracleDocument, 'create table sqlx_lob_probe (id number(10) primary key, c clob, b blob)');
  await execute(runtime, oracle, oracleDocument, `declare
    l_text varchar2(32000) := rpad('SQLExplorer LOB ', 32000, 'x');
    l_clob clob;
    l_blob blob;
  begin
    dbms_lob.createtemporary(l_clob, true);
    dbms_lob.createtemporary(l_blob, true);
    for i in 1..8 loop
      dbms_lob.append(l_clob, l_text);
      dbms_lob.append(l_blob, utl_raw.cast_to_raw(l_text));
    end loop;
    insert into sqlx_lob_probe (id, c, b) values (1, l_clob, l_blob);
    commit;
  end;`);

  const oraclePage = await execute(runtime, oracle, oracleDocument, 'select id, c, b from sqlx_lob_probe', 10);
  assert(!oraclePage.hasMore, 'Oracle LOB probe should finish in a single page');
  const clobCell = oraclePage.rows[0]?.cells[1];
  const blobCell = oraclePage.rows[0]?.cells[2];
  assert(isLobCellValue(clobCell) && clobCell.subtype === 'CLOB' && clobCell.size === 256_000,
    'Oracle CLOB marker is incomplete');
  assert(isLobCellValue(blobCell) && blobCell.subtype === 'BLOB' && blobCell.size === 256_000,
    'Oracle BLOB marker is incomplete');

  const firstChunk = await runtime.readLob({
    executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 1, offset: 0, length: 8_192,
  });
  assert(firstChunk.encoding === 'utf8' && firstChunk.data.length === 8_192 && !firstChunk.eof,
    'Oracle CLOB first chunk is wrong');
  const secondChunk = await runtime.readLob({
    executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 1, offset: firstChunk.nextOffset, length: 8_192,
  });
  assert(secondChunk.offset === 8_192 && secondChunk.data.length === 8_192,
    'Oracle CLOB second chunk is wrong');

  const clobText = await collectLob(runtime, { executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 1 });
  assert(clobText.length === 256_000 && clobText.startsWith('SQLExplorer LOB ') && clobText.endsWith('x'),
    'Oracle CLOB content is broken after the cursor completed');

  const blobBytes = await collectLobBytes(runtime, { executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 2 });
  assert(blobBytes.byteLength === 256_000 && blobBytes.subarray(0, 15).toString('utf8') === 'SQLExplorer LOB',
    'Oracle BLOB content is broken');

  const clobFile = path.join(probeDir, 'oracle-clob.txt');
  const savedClob = await runtime.saveLob({
    executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 1, suggestedName: 'oracle-clob.txt',
  }, clobFile);
  assert(savedClob.status === 'saved' && savedClob.bytes === 256_000, 'Oracle CLOB save failed');
  assert(fs.readFileSync(clobFile, 'utf8') === clobText, 'Oracle CLOB file content mismatch');

  const blobFile = path.join(probeDir, 'oracle-blob.bin');
  const savedBlob = await runtime.saveLob({
    executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 2, suggestedName: 'oracle-blob.bin',
  }, blobFile);
  assert(savedBlob.status === 'saved' && savedBlob.bytes === 256_000, 'Oracle BLOB save failed');
  assert(fs.readFileSync(blobFile).equals(blobBytes), 'Oracle BLOB file content mismatch');
  assert((await runtime.cancelLobSave('missing-operation')) === false, 'Unknown LOB save was not reported as missing');

  const exportFile = path.join(probeDir, 'oracle-probe.xlsx');
  const exportSession = new ExcelExportSession({
    columns: oraclePage.columns,
    executionId: oraclePage.executionId,
    filePath: exportFile,
    lobDirectory: path.join(probeDir, 'oracle-probe.lobs'),
    options: { lobMode: 'files' },
    source: runtime,
  });
  await exportSession.writeRows(oraclePage.rows);
  const exported = await exportSession.finish();
  assert(exported.rows === 1 && exported.lobFiles === 2, 'Excel export did not write the expected LOB files');
  const exportedWorkbook = new ExcelJS.Workbook();
  await exportedWorkbook.xlsx.readFile(exportFile);
  const exportedSheet = exportedWorkbook.getWorksheet('Результат');
  const clobLink = exportedSheet?.getCell('B2').value as { hyperlink?: string; text?: string } | undefined;
  const clobHyperlink = clobLink?.hyperlink;
  assert(clobHyperlink && clobHyperlink.endsWith('.txt') && clobLink?.text?.includes('CLOB'),
    'Excel CLOB hyperlink is missing');
  const exportedLobFile = path.join(probeDir, clobHyperlink);
  assert(fs.existsSync(exportedLobFile)
    && fs.statSync(exportedLobFile).size === Buffer.byteLength(clobText, 'utf8'),
  'Exported CLOB file is broken');

  await execute(runtime, postgres, postgresDocument, 'drop table if exists sqlx_lob_probe');
  await execute(runtime, postgres, postgresDocument, 'create table sqlx_lob_probe (id integer primary key, c text, b bytea)');
  await execute(runtime, postgres, postgresDocument,
    "insert into sqlx_lob_probe values (1, repeat('PostgreSQL LOB ', 16000), decode(repeat('41', 131072), 'hex'))");
  await execute(runtime, postgres, postgresDocument, 'commit');

  const budgetRequests: string[] = [];
  const budgetListener = (request: { executionId: string; requestId: string }) => {
    budgetRequests.push(request.requestId);
    void runtime.confirmLobBudget({
      requestId: request.requestId,
      executionId: request.executionId,
      allow: budgetRequests.length === 1,
    });
  };
  runtime.on('lob-budget', budgetListener);

  const postgresPage = await execute(runtime, postgres, postgresDocument, 'select id, c, b from sqlx_lob_probe', 10);
  assert(!postgresPage.hasMore, 'PostgreSQL LOB probe should finish in a single page');
  const textCell = postgresPage.rows[0]?.cells[1];
  const byteaCell = postgresPage.rows[0]?.cells[2];
  assert(isLobCellValue(textCell) && textCell.subtype === 'TEXT' && textCell.size === 240_000 && textCell.available,
    'PostgreSQL text marker is incomplete');
  assert(isLobCellValue(byteaCell) && byteaCell.subtype === 'BYTEA' && byteaCell.size === 131_072,
    'PostgreSQL bytea marker is incomplete');
  assert(isLobCellValue(byteaCell) && !byteaCell.available && byteaCell.note === 'budget',
    'PostgreSQL bytea did not respect the declined budget');
  assert(budgetRequests.length === 2, 'PostgreSQL budget requests were not raised');
  runtime.off('lob-budget', budgetListener);

  const pgText = await collectLob(runtime, { executionId: postgresPage.executionId, rowIndex: 1, columnIndex: 1 });
  assert(pgText === 'PostgreSQL LOB '.repeat(16_000), 'PostgreSQL text content is broken');

  let budgetRejected = false;
  try {
    await runtime.readLob({ executionId: postgresPage.executionId, rowIndex: 1, columnIndex: 2, offset: 0, length: 16 });
  } catch {
    budgetRejected = true;
  }
  assert(budgetRejected, 'A value declined by the budget still served data');

  const pgFile = path.join(probeDir, 'postgres-text.txt');
  const pgSaved = await runtime.saveLob({
    executionId: postgresPage.executionId, rowIndex: 1, columnIndex: 1, suggestedName: 'postgres-text.txt',
  }, pgFile);
  assert(pgSaved.status === 'saved' && pgSaved.bytes === Buffer.byteLength(pgText, 'utf8'),
    'PostgreSQL text save failed');
  assert(fs.readFileSync(pgFile, 'utf8') === pgText, 'PostgreSQL text file content mismatch');

  const pgByteaFile = path.join(probeDir, 'postgres-bytea.bin');
  const pgByteaSaved = await runtime.saveLob({
    executionId: postgresPage.executionId, rowIndex: 1, columnIndex: 2, suggestedName: 'postgres-bytea.bin',
  }, pgByteaFile);
  assert(pgByteaSaved.status === 'unavailable', 'A value declined by the budget was saved');

  await execute(runtime, oracle, oracleDocument, 'select 1 from dual', 1);
  let staleOracleRejected = false;
  try {
    await runtime.readLob({ executionId: oraclePage.executionId, rowIndex: 1, columnIndex: 1, offset: 0, length: 16 });
  } catch {
    staleOracleRejected = true;
  }
  assert(staleOracleRejected, 'A replaced Oracle execution still served LOB values');

  await execute(runtime, postgres, postgresDocument, 'select 1', 1);
  let stalePostgresRejected = false;
  try {
    await runtime.readLob({ executionId: postgresPage.executionId, rowIndex: 1, columnIndex: 1, offset: 0, length: 16 });
  } catch {
    stalePostgresRejected = true;
  }
  assert(stalePostgresRejected, 'A replaced PostgreSQL execution still served LOB values');

  await execute(runtime, oracle, oracleDocument, 'drop table sqlx_lob_probe purge');
  await execute(runtime, postgres, postgresDocument, 'drop table if exists sqlx_lob_probe');
  await execute(runtime, postgres, postgresDocument, 'commit');
  fs.rmSync(probeDir, { recursive: true, force: true });
}

async function execute(
  runtime: DatabaseRuntimeManager,
  profile: ConnectionProfile,
  documentId: string,
  sql: string,
  pageSize = 2,
  parameters?: Record<string, BindValue>,
): Promise<QueryPage> {
  const request: ExecuteRequest = {
    connectionId: profile.id,
    documentId,
    executionId: randomUUID(),
    pageSize,
    sql,
    parameters,
  };
  return runtime.execute(profile, request);
}

async function verifyBindSupport(
  runtime: DatabaseRuntimeManager,
  oracle: ConnectionProfile,
  postgres: ConnectionProfile,
): Promise<void> {
  const oracleDocument = 'integration-oracle-bind';
  const postgresDocument = 'integration-postgres-bind';

  await execute(runtime, oracle, oracleDocument, `begin
    execute immediate 'drop table sqlx_bind_probe purge';
  exception when others then null;
  end;`);
  await execute(runtime, oracle, oracleDocument,
    'create table sqlx_bind_probe (id number(10), name varchar2(64), amount number(12,2), note varchar2(64), created date)');
  await execute(runtime, oracle, oracleDocument,
    `insert into sqlx_bind_probe (id, name, amount, note, created)
     values (:id, :name, :amount, :note, :created)`, 2, {
      ID: { type: 'number', value: '1' },
      NAME: { type: 'string', value: 'bind probe' },
      AMOUNT: { type: 'number', value: '42.5' },
      NOTE: { type: 'null', value: '' },
      CREATED: { type: 'date', value: '2026-09-17' },
    });

  const oracleRow = await execute(runtime, oracle, oracleDocument,
    `select name, amount, note, to_char(created, 'YYYY-MM-DD') as created from sqlx_bind_probe where id = 1`, 1);
  assert(oracleRow.rows[0]?.cells[0] === 'bind probe', 'Oracle string bind produced wrong data');
  assert(oracleRow.rows[0]?.cells[1] === '42.5', 'Oracle number bind produced wrong data');
  assert(oracleRow.rows[0]?.cells[2] === null, 'Oracle null bind produced wrong data');
  assert(oracleRow.rows[0]?.cells[3] === '2026-09-17', 'Oracle date bind produced wrong data');

  const oracleDated = await execute(runtime, oracle, oracleDocument,
    `select to_char(:d, 'YYYY-MM-DD HH24:MI') as value from dual`, 1,
    { D: { type: 'date', value: '2026-09-17 14:05' } });
  assert(oracleDated.rows[0]?.cells[0] === '2026-09-17 14:05', 'Oracle date bind ignored the time part');

  const oracleRepeated = await execute(runtime, oracle, oracleDocument,
    'select :v || :v as doubled from dual', 1, { V: { type: 'string', value: 'ab' } });
  assert(oracleRepeated.rows[0]?.cells[0] === 'abab', 'Oracle repeated named bind is broken');

  const oracleLower = await execute(runtime, oracle, oracleDocument,
    'select :x as value from dual', 1, { X: { type: 'number', value: '7' } });
  assert(oracleLower.rows[0]?.cells[0] === '7', 'Oracle bind names are not case insensitive');

  const oracleRerun = await execute(runtime, oracle, oracleDocument,
    'select name from sqlx_bind_probe where id = :id', 1, { ID: { type: 'number', value: '999' } });
  assert(oracleRerun.rows.length === 0, 'Oracle re-run with a new bind value is broken');

  let oracleMissingRejected = false;
  try {
    await execute(runtime, oracle, oracleDocument, 'select :missing from dual', 1);
  } catch (error) {
    oracleMissingRejected = (error as Error & { kind?: string }).kind === 'bind';
  }
  assert(oracleMissingRejected, 'Oracle missing bind value was not reported as a bind error');

  let oracleInvalidRejected = false;
  try {
    await execute(runtime, oracle, oracleDocument, 'select :v from dual', 1,
      { V: { type: 'number', value: 'abc' } });
  } catch (error) {
    oracleInvalidRejected = (error as Error & { kind?: string }).kind === 'bind';
  }
  assert(oracleInvalidRejected, 'Oracle invalid number bind was not reported as a bind error');

  await execute(runtime, oracle, oracleDocument, 'drop table sqlx_bind_probe purge');

  await execute(runtime, postgres, postgresDocument, 'drop table if exists sqlx_bind_probe');
  await execute(runtime, postgres, postgresDocument,
    'create table sqlx_bind_probe (id integer, name text, amount numeric, note text, created date)');
  await execute(runtime, postgres, postgresDocument,
    `insert into sqlx_bind_probe (id, name, amount, note, created)
     values (:id, :name, :amount, :note, :created)`, 2, {
      id: { type: 'number', value: '1' },
      name: { type: 'string', value: 'bind probe' },
      amount: { type: 'number', value: '42.5' },
      note: { type: 'null', value: '' },
      created: { type: 'date', value: '2026-09-17' },
    });

  const postgresRow = await execute(runtime, postgres, postgresDocument,
    `select name, amount, note, to_char(created, 'YYYY-MM-DD') as created from sqlx_bind_probe where id = 1`, 1);
  assert(postgresRow.rows[0]?.cells[0] === 'bind probe', 'PostgreSQL string bind produced wrong data');
  assert(postgresRow.rows[0]?.cells[1] === '42.5', 'PostgreSQL number bind produced wrong data');
  assert(postgresRow.rows[0]?.cells[2] === null, 'PostgreSQL null bind produced wrong data');
  assert(postgresRow.rows[0]?.cells[3] === '2026-09-17', 'PostgreSQL date bind produced wrong data');

  const postgresNative = await execute(runtime, postgres, postgresDocument,
    'select name from sqlx_bind_probe where id = $1 and amount > $2', 1, {
      '$1': { type: 'number', value: '1' },
      '$2': { type: 'number', value: '10' },
    });
  assert(postgresNative.rows.length === 1, 'PostgreSQL native $n binds are broken');

  const postgresMixed = await execute(runtime, postgres, postgresDocument,
    'select name from sqlx_bind_probe where id = :id and name = $1', 1, {
      id: { type: 'number', value: '1' },
      '$1': { type: 'string', value: 'bind probe' },
    });
  assert(postgresMixed.rows.length === 1, 'PostgreSQL mixed named and native binds are broken');

  const postgresRepeated = await execute(runtime, postgres, postgresDocument,
    'select :v || :v as doubled', 1, { v: { type: 'string', value: 'ab' } });
  assert(postgresRepeated.rows[0]?.cells[0] === 'abab', 'PostgreSQL repeated named bind is broken');

  const postgresRepeatedNative = await execute(runtime, postgres, postgresDocument,
    'select $1 || $1 as doubled', 1, { '$1': { type: 'string', value: 'xy' } });
  assert(postgresRepeatedNative.rows[0]?.cells[0] === 'xyxy', 'PostgreSQL repeated native bind is broken');

  const postgresTyped = await execute(runtime, postgres, postgresDocument,
    `select to_char($1::date, 'YYYY-MM-DD') as value`, 1, { '$1': { type: 'date', value: '2026-09-17' } });
  assert(postgresTyped.rows[0]?.cells[0] === '2026-09-17',
    'PostgreSQL typed date bind is broken');

  const postgresEmpty = await execute(runtime, postgres, postgresDocument,
    `select :v = '' as value`, 1, { v: { type: 'string', value: '' } });
  assert(postgresEmpty.rows[0]?.cells[0] === true, 'PostgreSQL empty string bind is broken');

  const postgresRerun = await execute(runtime, postgres, postgresDocument,
    'select name from sqlx_bind_probe where id = :id', 1, { id: { type: 'number', value: '999' } });
  assert(postgresRerun.rows.length === 0, 'PostgreSQL re-run with a new bind value is broken');

  let postgresMissingRejected = false;
  try {
    await execute(runtime, postgres, postgresDocument, 'select :missing', 1);
  } catch (error) {
    postgresMissingRejected = (error as Error & { kind?: string }).kind === 'bind';
  }
  assert(postgresMissingRejected, 'PostgreSQL missing bind value was not reported as a bind error');

  let postgresInvalidRejected = false;
  try {
    await execute(runtime, postgres, postgresDocument, 'select :v', 1,
      { v: { type: 'date', value: 'not-a-date' } });
  } catch (error) {
    postgresInvalidRejected = (error as Error & { kind?: string }).kind === 'bind';
  }
  assert(postgresInvalidRejected, 'PostgreSQL invalid date bind was not reported as a bind error');

  await execute(runtime, postgres, postgresDocument, 'drop table if exists sqlx_bind_probe');
  await execute(runtime, postgres, postgresDocument, 'commit');
}

async function verifyCancellation(
  runtime: DatabaseRuntimeManager,
  profile: ConnectionProfile,
  documentId: string,
  sql: string,
): Promise<void> {
  const executionId = randomUUID();
  const running = runtime.execute(profile, {
    connectionId: profile.id,
    documentId,
    executionId,
    pageSize: 2,
    sql,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  const cancelled = await runtime.cancel(executionId);
  assert(cancelled, `${profile.kind}: cancel request did not find the running execution`);
  try {
    await running;
    throw new Error(`${profile.kind}: long query completed instead of being cancelled`);
  } catch (error) {
    if (String((error as Error).message).includes('completed instead')) throw error;
  }
}

export async function runDatabaseSelfTest(
  runtime: DatabaseRuntimeManager,
  registry: ConnectionRegistry,
  root: string,
): Promise<void> {
  const publicProfiles = registry.list();
  const oraclePublic = publicProfiles.find((profile) => profile.kind === 'oracle');
  const postgresPublic = publicProfiles.find((profile) => profile.kind === 'postgres');
  assert(oraclePublic && postgresPublic, 'Oracle and PostgreSQL test profiles are required');
  const oracle = await registry.get(oraclePublic.id);
  const postgres = await registry.get(postgresPublic.id);

  const [oracleConnection, postgresConnection] = await Promise.all([
    runtime.testConnection(oracle),
    runtime.testConnection(postgres),
  ]);
  assert(oracleConnection.serverVersion && postgresConnection.serverVersion, 'Server version is missing');

  const [oracleOverview, postgresOverview] = await Promise.all([
    runtime.catalogOverview(oracle),
    runtime.catalogOverview(postgres),
  ]);
  assert(oracleOverview.currentSchema && oracleOverview.schemas.includes('SQLX'), 'Oracle catalog overview is incomplete');
  assert(postgresOverview.currentSchema, 'PostgreSQL catalog overview is incomplete');
  const oracleObjects = await runtime.listObjects(oracle, {
    schema: oracleOverview.currentSchema, prefix: 'EMP', caseSensitive: false, limit: 50,
  });
  assert(oracleObjects.objects.some((object) => object.name === 'EMPLOYEES'), 'Oracle catalog objects are incomplete');
  const oracleColumns = await runtime.listColumns(oracle, oracleOverview.currentSchema, 'EMPLOYEES');
  assert(oracleColumns.some((column) => column.name === 'EMPLOYEE_ID'), 'Oracle catalog columns are incomplete');
  const postgresObjects = await runtime.listObjects(postgres, {
    schema: 'public', prefix: 'emp', caseSensitive: false, limit: 50,
  });
  assert(postgresObjects.objects.some((object) => object.name === 'employees'), 'PostgreSQL catalog objects are incomplete');
  const postgresColumns = await runtime.listColumns(postgres, 'public', 'employees');
  assert(postgresColumns.some((column) => column.name === 'employee_id'), 'PostgreSQL catalog columns are incomplete');

  const oracleDocument = 'integration-oracle-thin';
  const oraclePage = await execute(runtime, oracle, oracleDocument, 'select employee_id, full_name from employees order by employee_id');
  assert(oraclePage.rows.length === 2 && oraclePage.hasMore, 'Oracle paging did not return the first page');
  const oracleNext = await runtime.fetchMore({ executionId: oraclePage.executionId, pageSize: 2 });
  assert(oracleNext.rows.length === 1, 'Oracle paging did not return the remaining row');

  const postgresDocument = 'integration-postgres';
  const postgresPage = await execute(runtime, postgres, postgresDocument, 'select employee_id, full_name from employees order by employee_id');
  assert(postgresPage.rows.length === 2 && postgresPage.hasMore, 'PostgreSQL paging did not return the first page');
  const postgresNext = await runtime.fetchMore({ executionId: postgresPage.executionId, pageSize: 2 });
  assert(postgresNext.rows.length === 1, 'PostgreSQL paging did not return the remaining row');

  const oraclePublicSynonyms = await runtime.listObjects(oracle, {
    schema: 'PUBLIC', prefix: 'DUA', caseSensitive: false, limit: 10,
  });
  assert(oraclePublicSynonyms.objects.some((object) => object.name === 'DUAL'), 'Oracle PUBLIC synonyms are not visible');
  const oracleSystemSchema = await runtime.listObjects(oracle, {
    schema: 'SYS', prefix: 'USER_TABLES', caseSensitive: false, limit: 10,
  });
  assert(oracleSystemSchema.objects.some((object) => object.name === 'USER_TABLES'), 'Oracle sys. objects are not visible');

  const postgresSessionContext = await runtime.sessionContext(postgres, {
    connectionId: postgres.id, documentId: postgresDocument,
  });
  assert(postgresSessionContext?.currentSchema === 'public', 'PostgreSQL session context is incomplete');
  const switchedContext = await runtime.setSessionSchema(postgres, {
    connectionId: postgres.id, documentId: postgresDocument, schema: 'public',
  });
  assert(switchedContext?.searchPath.includes('public'), 'PostgreSQL search_path did not switch to the requested schema');

  await execute(runtime, oracle, oracleDocument, "insert into departments (department_id, department_name) values (9999, 'Rollback probe')");
  await runtime.rollback(oracle, { connectionId: oracle.id, documentId: oracleDocument });
  const oracleRollback = await execute(runtime, oracle, oracleDocument, 'select count(*) from departments where department_id = 9999');
  assert(oracleRollback.rows[0]?.cells[0] === '0', 'Oracle rollback did not restore the original state');

  await execute(runtime, postgres, postgresDocument, "insert into departments (department_id, department_name) values (9999, 'Rollback probe')");
  await runtime.rollback(postgres, { connectionId: postgres.id, documentId: postgresDocument });
  const postgresRollback = await execute(runtime, postgres, postgresDocument, 'select count(*) from departments where department_id = 9999');
  assert(postgresRollback.rows[0]?.cells[0] === '0', 'PostgreSQL rollback did not restore the original state');
  await execute(runtime, postgres, postgresDocument, "insert into departments (department_id, department_name) values (9996, 'SQL rollback probe')");
  const explicitRollback = await execute(runtime, postgres, postgresDocument, 'rollback');
  assert(explicitRollback.transactionState === 'clean', 'Explicit PostgreSQL ROLLBACK did not clear transaction state');
  const explicitRollbackCheck = await execute(runtime, postgres, postgresDocument, 'select count(*) from departments where department_id = 9996', 1);
  assert(explicitRollbackCheck.rows[0]?.cells[0] === '0', 'Explicit PostgreSQL ROLLBACK did not restore data');

  const isolatedWriter = 'integration-postgres-isolated-writer';
  const isolatedReader = 'integration-postgres-isolated-reader';
  await execute(runtime, postgres, isolatedWriter, "insert into departments (department_id, department_name) values (9998, 'Isolation probe')");
  const invisible = await execute(runtime, postgres, isolatedReader, 'select count(*) from departments where department_id = 9998', 1);
  assert(invisible.rows[0]?.cells[0] === '0', 'Two tabs unexpectedly shared a PostgreSQL transaction');
  await runtime.rollback(postgres, { connectionId: postgres.id, documentId: isolatedWriter });

  const reconnectDocument = 'integration-postgres-reconnect';
  const backend = await execute(runtime, postgres, reconnectDocument, 'select pg_backend_pid()', 1);
  const backendPid = Number(backend.rows[0]?.cells[0]);
  assert(Number.isInteger(backendPid) && backendPid > 0, 'PostgreSQL backend pid is missing');
  const lost = new Promise<SessionState>((resolve, reject) => {
    const timeout = setTimeout(() => {
      runtime.off('session-state', listener);
      reject(new Error('PostgreSQL lost-session event timed out'));
    }, 5_000);
    const listener = (state: SessionState) => {
      if (state.documentId !== reconnectDocument || state.status !== 'lost') return;
      clearTimeout(timeout);
      runtime.off('session-state', listener);
      resolve(state);
    };
    runtime.on('session-state', listener);
  });
  const terminated = await execute(runtime, postgres, 'integration-postgres-killer', `select pg_terminate_backend(${backendPid})`, 1);
  assert(terminated.rows[0]?.cells[0] === true, 'PostgreSQL test backend was not terminated');
  let firstExecutionFailed = false;
  try {
    await execute(runtime, postgres, reconnectDocument, 'select 41', 1);
  } catch {
    firstExecutionFailed = true;
  }
  assert(firstExecutionFailed, 'A command sent to a lost PostgreSQL connection was retried automatically');
  const lostState = await lost;
  assert(lostState.status === 'lost', 'PostgreSQL session was not marked lost');
  const reconnected = await execute(runtime, postgres, reconnectDocument, 'select 42', 1);
  assert(reconnected.rows[0]?.cells[0] === 42, 'Next explicit PostgreSQL execution did not reconnect');

  const netConfigDir = path.join(root, 'infra', 'oracle');
  const tnsProfile: ConnectionProfile = {
    ...oracle,
    id: 'oracle-tns-test',
    addressMode: 'tnsAlias',
    tnsAlias: 'SQLX_LOCAL',
    database: 'SQLX_LOCAL',
    effectiveNetConfigDir: netConfigDir,
  };
  const customProfile: ConnectionProfile = {
    ...oracle,
    id: 'oracle-custom-test',
    addressMode: 'connectString',
    connectString: `${oracle.host}:${oracle.port}/${oracle.serviceName ?? oracle.database}`,
  };
  const [tnsResult, customResult] = await Promise.all([
    runtime.testConnection(tnsProfile),
    runtime.testConnection(customProfile),
  ]);
  assert(tnsResult.serverVersion && customResult.serverVersion, 'Oracle TNS/custom connection test failed');
  const aliases = await runtime.listTnsAliases(netConfigDir);
  assert(aliases.includes('SQLX_LOCAL'), 'TNS alias discovery is incomplete');

  const client = registry.oracleClients()[0];
  let thick = 'skipped';
  let thickRuntimeKeys = 0;
  let sysdba = 'skipped';
  if (client) {
    const thickProfile: ConnectionProfile = {
      ...oracle,
      id: 'oracle-thick-test',
      driverMode: 'thick',
      oracleClientId: client.id,
      oracleClientName: client.name,
      oracleClientLibDir: client.libDir,
      effectiveNetConfigDir: netConfigDir,
    };
    const [thinResult, thickResult] = await Promise.all([
      runtime.testConnection(oracle),
      runtime.testConnection(thickProfile),
    ]);
    assert(thinResult.driverMode === 'thin' && thickResult.driverMode === 'thick', 'Thin and Thick did not run simultaneously');
    const page = await execute(runtime, thickProfile, 'integration-oracle-thick', 'select full_name from employees order by employee_id');
    assert(page.rows.length > 0, 'Oracle Thick query returned no rows');
    thick = thickResult.oracleClientVersion ?? 'connected';
    thickRuntimeKeys = 1;

    const runtimeSwitchDocument = 'integration-oracle-runtime-switch';
    await execute(runtime, oracle, runtimeSwitchDocument, 'select 1 from dual', 1);
    const switchedProfile: ConnectionProfile = {
      ...thickProfile,
      id: oracle.id,
      profileVersion: oracle.profileVersion + 1,
    };
    await execute(runtime, switchedProfile, runtimeSwitchDocument, 'select 2 from dual', 1);
    const switchedState = runtime.states().find((state) => state.documentId === runtimeSwitchDocument);
    assert(switchedState?.runtimeKey?.startsWith('oracle:thick:'), 'Profile mode change did not move the session to Thick runtime');

    const thickTns: ConnectionProfile = {
      ...thickProfile,
      id: 'oracle-thick-tns-test',
      addressMode: 'tnsAlias',
      tnsAlias: 'SQLX_LOCAL',
      database: 'SQLX_LOCAL',
    };
    const thickCustom: ConnectionProfile = {
      ...thickProfile,
      id: 'oracle-thick-custom-test',
      addressMode: 'connectString',
      connectString: `${oracle.host}:${oracle.port}/${oracle.serviceName ?? oracle.database}`,
    };
    const thickAddressResults = await Promise.all([
      runtime.testConnection(thickTns),
      runtime.testConnection(thickCustom),
    ]);
    assert(thickAddressResults.every((result) => result.driverMode === 'thick'), 'Thick TNS/custom connection failed');

    const secondNetConfigDir = path.join(client.libDir, 'network', 'admin');
    if (fs.existsSync(path.join(secondNetConfigDir, 'tnsnames.ora'))) {
      const secondThickProfile: ConnectionProfile = {
        ...thickProfile,
        id: 'oracle-thick-second-runtime-test',
        effectiveNetConfigDir: secondNetConfigDir,
      };
      const secondResult = await runtime.testConnection(secondThickProfile);
      assert(secondResult.driverMode === 'thick', 'Second Thick runtime key failed');
      thickRuntimeKeys = 2;
    }

    const adminPasswordPath = path.join(root, '.local', 'oracle', 'admin-password.txt');
    if (fs.existsSync(adminPasswordPath)) {
      const sysPassword = fs.readFileSync(adminPasswordPath, 'utf8').trim();
      const sysThin: ConnectionProfile = {
        ...oracle,
        id: 'oracle-sysdba-thin-test',
        username: 'sys',
        password: sysPassword,
        privilege: 'sysdba',
      };
      const sysThick: ConnectionProfile = {
        ...thickProfile,
        id: 'oracle-sysdba-thick-test',
        username: 'sys',
        password: sysPassword,
        privilege: 'sysdba',
      };
      const sysResults = await Promise.all([
        runtime.testConnection(sysThin),
        runtime.testConnection(sysThick),
      ]);
      assert(sysResults.every((result) => result.serverVersion), 'SYSDBA connection failed');
      sysdba = 'passed';
    }
  }

  await verifyLobSupport(runtime, oracle, postgres);
  await verifyBindSupport(runtime, oracle, postgres);
  await verifyCancellation(runtime, oracle, oracleDocument, 'begin dbms_session.sleep(5); end;');
  await verifyCancellation(runtime, postgres, postgresDocument, 'select pg_sleep(5)');

  console.log(`DATABASE_SELF_TEST_OK oracle=${oracleConnection.serverVersion} postgres=${postgresConnection.serverVersion} thick=${thick} thickKeys=${thickRuntimeKeys} sysdba=${sysdba} reconnect=passed lob=passed bind=passed`);
}
