import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerPath = path.join(projectRoot, '.vite', 'build', 'db-worker.js');

if (!fs.existsSync(workerPath)) {
  throw new Error('Database worker is not built. Run npm run package first.');
}

function readConfig(kind) {
  const file = path.join(projectRoot, '.local', kind, 'connection.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const oracleConfig = readConfig('oracle');
const postgresConfig = readConfig('postgres');
const profiles = {
  oracle: {
    id: 'oracle-local',
    name: 'Oracle local',
    kind: 'oracle',
    color: '#db662d',
    host: oracleConfig.host,
    port: oracleConfig.port,
    database: oracleConfig.serviceName,
    serviceName: oracleConfig.serviceName,
    username: oracleConfig.username,
    password: oracleConfig.password,
    connectString: `${oracleConfig.host}:${oracleConfig.port}/${oracleConfig.serviceName}`,
    status: 'configured',
  },
  postgres: {
    id: 'postgres-local',
    name: 'PostgreSQL local',
    kind: 'postgres',
    color: '#3676d8',
    host: postgresConfig.host,
    port: postgresConfig.port,
    database: postgresConfig.database,
    username: postgresConfig.username,
    password: postgresConfig.password,
    status: 'configured',
  },
};

class WorkerClient {
  pending = new Map();
  worker = new Worker(workerPath);

  constructor() {
    this.worker.on('message', (response) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
  }

  call(method, payload) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, payload });
    });
  }

  async close() {
    await this.call('close');
    await this.worker.terminate();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function execute(client, profile, documentId, sql, pageSize = 2) {
  const request = {
    connectionId: profile.id,
    documentId,
    executionId: randomUUID(),
    pageSize,
    sql,
  };
  return client.call('execute', { profile, request });
}

async function verifyCancellation(client, profile, documentId, sql) {
  const executionId = randomUUID();
  const running = client.call('execute', {
    profile,
    request: {
      connectionId: profile.id,
      documentId,
      executionId,
      pageSize: 2,
      sql,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const cancelled = await client.call('cancel', { executionId });
  assert(cancelled, `${profile.kind}: cancel request did not find the running execution`);
  try {
    await running;
    throw new Error(`${profile.kind}: long query completed instead of being cancelled`);
  } catch (error) {
    if (String(error.message).includes('completed instead')) throw error;
  }
}

const client = new WorkerClient();

try {
  const connectionResults = await Promise.all([
    client.call('testConnection', { profile: profiles.oracle }),
    client.call('testConnection', { profile: profiles.postgres }),
  ]);
  assert(connectionResults.every((result) => result.serverVersion), 'Server version is missing');

  const metadata = await Promise.all([
    client.call('refreshMetadata', { profile: profiles.oracle }),
    client.call('refreshMetadata', { profile: profiles.postgres }),
  ]);
  assert(metadata[0].objects.some((object) => object.name === 'EMPLOYEES'), 'Oracle metadata is incomplete');
  assert(metadata[1].objects.some((object) => object.name === 'employees'), 'PostgreSQL metadata is incomplete');

  const oracleDocument = 'integration-oracle';
  const oraclePage = await execute(
    client,
    profiles.oracle,
    oracleDocument,
    'select employee_id, full_name from employees order by employee_id',
  );
  assert(oraclePage.rows.length === 2 && oraclePage.hasMore, 'Oracle paging did not return the first page');
  const oracleNext = await client.call('fetchMore', { executionId: oraclePage.executionId, pageSize: 2 });
  assert(oracleNext.rows.length === 1, 'Oracle paging did not return the remaining row');

  const postgresDocument = 'integration-postgres';
  const postgresPage = await execute(
    client,
    profiles.postgres,
    postgresDocument,
    'select employee_id, full_name from employees order by employee_id',
  );
  assert(postgresPage.rows.length === 2 && postgresPage.hasMore, 'PostgreSQL paging did not return the first page');
  const postgresNext = await client.call('fetchMore', { executionId: postgresPage.executionId, pageSize: 2 });
  assert(postgresNext.rows.length === 1, 'PostgreSQL paging did not return the remaining row');

  await execute(
    client,
    profiles.oracle,
    oracleDocument,
    "insert into departments (department_id, department_name) values (9999, 'Rollback probe')",
  );
  await client.call('rollback', {
    profile: profiles.oracle,
    request: { connectionId: profiles.oracle.id, documentId: oracleDocument },
  });
  const oracleRollback = await execute(
    client,
    profiles.oracle,
    oracleDocument,
    'select count(*) from departments where department_id = 9999',
  );
  assert(oracleRollback.rows[0]?.cells[0] === '0', 'Oracle rollback did not restore the original state');

  await execute(
    client,
    profiles.postgres,
    postgresDocument,
    "insert into departments (department_id, department_name) values (9999, 'Rollback probe')",
  );
  await client.call('rollback', {
    profile: profiles.postgres,
    request: { connectionId: profiles.postgres.id, documentId: postgresDocument },
  });
  const postgresRollback = await execute(
    client,
    profiles.postgres,
    postgresDocument,
    'select count(*) from departments where department_id = 9999',
  );
  assert(postgresRollback.rows[0]?.cells[0] === '0', 'PostgreSQL rollback did not restore the original state');

  await verifyCancellation(client, profiles.oracle, oracleDocument, 'begin dbms_session.sleep(5); end;');
  await verifyCancellation(client, profiles.postgres, postgresDocument, 'select pg_sleep(5)');

  console.log('Database integration passed: Oracle and PostgreSQL connect, page, rollback, cancel, and expose metadata.');
} finally {
  await client.close();
}
