import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDirectory = path.join(projectRoot, 'node_modules', 'electron');
const pathFile = path.join(electronDirectory, 'path.txt');

if (!fs.existsSync(pathFile)) {
  const installer = path.join(electronDirectory, 'install.js');
  if (!fs.existsSync(installer)) throw new Error('The Electron npm package is not installed');
  const result = spawnSync(process.execPath, [installer], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
