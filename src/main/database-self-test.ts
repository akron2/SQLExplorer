import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionProfile, ExecuteRequest, QueryPage, SessionState } from '../shared/contracts';
import type { ConnectionRegistry } from './connection-registry';
import type { DatabaseRuntimeManager } from './database-runtime-manager';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function execute(
  runtime: DatabaseRuntimeManager,
  profile: ConnectionProfile,
  documentId: string,
  sql: string,
  pageSize = 2,
): Promise<QueryPage> {
  const request: ExecuteRequest = {
    connectionId: profile.id,
    documentId,
    executionId: randomUUID(),
    pageSize,
    sql,
  };
  return runtime.execute(profile, request);
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

  const metadata = await Promise.all([
    runtime.refreshMetadata(oracle),
    runtime.refreshMetadata(postgres),
  ]);
  assert(metadata[0].objects.some((object) => object.name === 'EMPLOYEES'), 'Oracle metadata is incomplete');
  assert(metadata[1].objects.some((object) => object.name === 'employees'), 'PostgreSQL metadata is incomplete');

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

  await verifyCancellation(runtime, oracle, oracleDocument, 'begin dbms_session.sleep(5); end;');
  await verifyCancellation(runtime, postgres, postgresDocument, 'select pg_sleep(5)');

  console.log(`DATABASE_SELF_TEST_OK oracle=${oracleConnection.serverVersion} postgres=${postgresConnection.serverVersion} thick=${thick} thickKeys=${thickRuntimeKeys} sysdba=${sysdba} reconnect=passed`);
}
