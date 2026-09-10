import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const executeFile = promisify(execFile);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = path.join(
  projectRoot,
  'out',
  'release',
  'SQLExplorer-win32-x64',
  'SQLExplorer.exe',
);

if (process.platform !== 'win32') {
  throw new Error('The local package smoke script currently targets the Windows build');
}
if (!fs.existsSync(executable)) {
  throw new Error('Packaged application not found. Run npm run package first.');
}

const tempRoot = path.resolve(os.tmpdir());
const testUserData = fs.mkdtempSync(path.join(tempRoot, 'sqlexplorer-package-test-'));
const resolvedTestData = path.resolve(testUserData);
if (!resolvedTestData.startsWith(`${tempRoot}${path.sep}`)) {
  throw new Error(`Unexpected test directory: ${resolvedTestData}`);
}

try {
  const { stdout } = await executeFile(executable, ['--smoke-test'], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      SQLX_CONFIG_ROOT: projectRoot,
      SQLX_TEST_USER_DATA: testUserData,
    },
    timeout: 30_000,
    windowsHide: true,
  });
  if (!stdout.includes('PACKAGE_SMOKE_OK')) {
    throw new Error(`Packaged smoke marker is missing. Output: ${stdout}`);
  }
  console.log(stdout.trim());
} finally {
  fs.rmSync(resolvedTestData, { recursive: true, force: true });
}
