import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configFiles = [
  'vite.main.config.mts',
  'vite.preload.config.mts',
  'vite.worker.config.mts',
  'vite.renderer.config.mts',
];

export async function buildApplication() {
  for (const configFile of configFiles) {
    await build({ configFile: path.join(projectRoot, configFile) });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildApplication();
}
