import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildApplication } from './build.mjs';

const executeFile = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDirectory = path.join(projectRoot, 'node_modules', 'electron');
const relativeExecutable = fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim();
const executable = path.join(electronDirectory, 'dist', relativeExecutable);
const tempRoot = path.resolve(os.tmpdir());
const userData = fs.mkdtempSync(path.join(tempRoot, 'sqlexplorer-db-test-'));
const resolvedUserData = path.resolve(userData);

if (!resolvedUserData.startsWith(`${tempRoot}${path.sep}`)) {
  throw new Error(`Unexpected test directory: ${resolvedUserData}`);
}

await buildApplication();

try {
  const { stdout, stderr } = await executeFile(executable, [projectRoot, '--database-test'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SQLX_CONFIG_ROOT: projectRoot,
      SQLX_TEST_USER_DATA: userData,
    },
    timeout: 90_000,
    windowsHide: true,
  });
  if (!stdout.includes('DATABASE_SELF_TEST_OK')) {
    throw new Error(`Database self-test marker is missing. stdout=${stdout} stderr=${stderr}`);
  }
  console.log(stdout.trim());
} finally {
  fs.rmSync(resolvedUserData, { recursive: true, force: true });
}
