import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { packager } from '@electron/packager';
import { buildApplication } from './build.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(projectRoot, 'out', 'release');

await buildApplication();

const packagedPaths = await packager({
  dir: projectRoot,
  out: outputDirectory,
  overwrite: true,
  prune: true,
  asar: { unpack: '**/*.node' },
  name: 'SQLExplorer',
  executableName: 'SQLExplorer',
  appBundleId: 'com.sqlexplorer.desktop',
  appCategoryType: 'public.app-category.developer-tools',
  platform: process.platform,
  arch: process.arch,
  ignore: [
    /^\/(?:\.git|\.local|\.playwright-mcp|coverage|docs|infra|out|playwright-report|test-results|tests|tmp)(?:\/|$)/u,
    /^\/(?:scripts|src)(?:\/|$)/u,
    /^\/(?:eslint\.config\.mjs|package-lock\.json|playwright\..*|tsconfig\.json|vite\..*|vitest\..*)(?:$|\/)/u,
  ],
  win32metadata: {
    CompanyName: 'SQLExplorer',
    FileDescription: 'SQLExplorer database client',
    ProductName: 'SQLExplorer',
  },
});

function executablePath(packageDirectory) {
  if (process.platform === 'win32') return path.join(packageDirectory, 'SQLExplorer.exe');
  if (process.platform === 'darwin') {
    return path.join(packageDirectory, 'SQLExplorer.app', 'Contents', 'MacOS', 'SQLExplorer');
  }
  return path.join(packageDirectory, 'SQLExplorer');
}

for (const packageDirectory of packagedPaths) {
  const applicationExecutable = executablePath(packageDirectory);
  if (!fs.existsSync(applicationExecutable)) {
    throw new Error(`Packaged executable was not found: ${applicationExecutable}`);
  }
  await flipFuses(applicationExecutable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`Packaged ${packageDirectory}`);
}
