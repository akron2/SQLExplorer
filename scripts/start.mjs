import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApplication } from './build.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDirectory = path.join(projectRoot, 'node_modules', 'electron');
const relativeExecutable = fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim();
const executable = path.join(electronDirectory, 'dist', relativeExecutable);

await buildApplication();

const child = spawn(executable, [projectRoot, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: { ...process.env, NODE_ENV: 'development' },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 0));
