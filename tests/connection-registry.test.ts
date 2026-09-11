// @vitest-environment node

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../src/main/connection-registry';
import type { SecretStorage } from '../src/main/secret-storage';
import { WorkspaceStore } from '../src/main/workspace-store';

const createdFiles: string[] = [];
const createdDirectories: string[] = [];

class TestSecrets implements SecretStorage {
  available(): Promise<boolean> { return Promise.resolve(true); }
  decrypt(value: string): Promise<string> { return Promise.resolve(Buffer.from(value, 'base64').toString('utf8').split('').reverse().join('')); }
  encrypt(value: string): Promise<string> { return Promise.resolve(Buffer.from(value.split('').reverse().join('')).toString('base64')); }
}

class UnavailableSecrets implements SecretStorage {
  available(): Promise<boolean> { return Promise.resolve(false); }
  decrypt(): Promise<string> { return Promise.reject(new Error('unavailable')); }
  encrypt(): Promise<string> { return Promise.reject(new Error('unavailable')); }
}

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    if (existsSync(file)) rmSync(file, { force: true });
    if (existsSync(`${file}-shm`)) rmSync(`${file}-shm`, { force: true });
    if (existsSync(`${file}-wal`)) rmSync(`${file}-wal`, { force: true });
  }
  for (const directory of createdDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

function testDirectory(withTns = false): string {
  const directory = path.join(tmpdir(), `sqlexplorer-directory-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  if (withTns) writeFileSync(path.join(directory, 'tnsnames.ora'), 'ORCL=(DESCRIPTION=())');
  createdDirectories.push(directory);
  return directory;
}

function registryFixture() {
  const file = path.join(tmpdir(), `sqlexplorer-registry-${crypto.randomUUID()}.sqlite`);
  createdFiles.push(file);
  const store = new WorkspaceStore(file);
  const registry = new ConnectionRegistry(store, new TestSecrets(), path.dirname(file), false);
  return { file, store, registry };
}

describe('ConnectionRegistry', () => {
  it('persists a profile without exposing or storing a plaintext password', async () => {
    const { store, registry } = registryFixture();
    await registry.initialize();
    const saved = await registry.save({
      kind: 'postgres', name: 'Reports', color: '#3676d8', username: 'reporter',
      password: 'top-secret', rememberPassword: true,
      host: 'db.internal', port: 5432, database: 'reports',
    });
    expect(saved.credentialState).toBe('saved');
    expect(JSON.stringify(registry.list())).not.toContain('top-secret');
    expect(store.loadEncryptedPassword(saved.id)).not.toContain('top-secret');
    expect((await registry.get(saved.id)).password).toBe('top-secret');
    store.close();
  });

  it('increments profileVersion only for connection-critical changes', async () => {
    const { store, registry } = registryFixture();
    await registry.initialize();
    const saved = await registry.save({
      kind: 'postgres', name: 'A', color: '#000000', username: 'u', password: 'p',
      rememberPassword: false, host: 'one', port: 5432, database: 'db',
    });
    const renamed = await registry.save({
      id: saved.id, kind: 'postgres', name: 'B', color: '#ffffff', username: 'u',
      rememberPassword: false, host: 'one', port: 5432, database: 'db',
    });
    expect(renamed.profileVersion).toBe(saved.profileVersion);
    const moved = await registry.save({
      id: saved.id, kind: 'postgres', name: 'B', color: '#ffffff', username: 'u',
      rememberPassword: false, host: 'two', port: 5432, database: 'db',
    });
    expect(moved.profileVersion).toBe(saved.profileVersion + 1);
    store.close();
  });

  it('resolves Thick Oracle settings, TNS directory and SYSDBA', async () => {
    const { store, registry } = registryFixture();
    await registry.initialize();
    const netDir = testDirectory(true);
    const clientDir = testDirectory();
    registry.saveOracleSettings({ defaultNetConfigDir: netDir });
    const client = registry.saveOracleClient({ name: 'Client 19', libDir: clientDir });
    const saved = await registry.save({
      kind: 'oracle', name: 'Admin', color: '#e36b2c', username: 'sys', password: 'p',
      rememberPassword: false, host: '', port: 1521, database: 'ORCL',
      driverMode: 'thick', addressMode: 'tnsAlias', tnsAlias: 'ORCL', privilege: 'sysdba',
      netConfigSource: 'default', oracleClientId: client.id,
    });
    const resolved = await registry.get(saved.id);
    expect(resolved).toMatchObject({
      driverMode: 'thick', privilege: 'sysdba', tnsAlias: 'ORCL',
      effectiveNetConfigDir: netDir,
      oracleClientLibDir: clientDir,
    });
    store.close();
  });

  it('keeps a password in memory only when protected storage is unavailable', async () => {
    const file = path.join(tmpdir(), `sqlexplorer-registry-${crypto.randomUUID()}.sqlite`);
    createdFiles.push(file);
    const store = new WorkspaceStore(file);
    const registry = new ConnectionRegistry(store, new UnavailableSecrets(), path.dirname(file), false);
    await registry.initialize();
    const saved = await registry.save({
      kind: 'postgres', name: 'Session only', color: '#3676d8', username: 'u', password: 'memory-secret',
      rememberPassword: true, host: 'localhost', port: 5432, database: 'db',
    });
    expect(saved.credentialState).toBe('session');
    expect(store.loadEncryptedPassword(saved.id)).toBeUndefined();
    expect((await registry.get(saved.id)).password).toBe('memory-secret');
    store.close();

    const reopenedStore = new WorkspaceStore(file);
    const reopened = new ConnectionRegistry(reopenedStore, new UnavailableSecrets(), path.dirname(file), false);
    await reopened.initialize();
    expect(reopened.list()[0].credentialState).toBe('missing');
    await expect(reopened.get(saved.id)).rejects.toThrow(/не указан пароль/u);
    reopenedStore.close();
  });

  it('marks profiles using the global Oracle Net directory as a new version', async () => {
    const { store, registry } = registryFixture();
    await registry.initialize();
    const firstNetDir = testDirectory(true);
    const secondNetDir = testDirectory(true);
    registry.saveOracleSettings({ defaultNetConfigDir: firstNetDir });
    const profile = await registry.save({
      kind: 'oracle', name: 'TNS', color: '#e36b2c', username: 'u', password: 'p',
      rememberPassword: false, host: '', port: 1521, database: 'ORCL',
      driverMode: 'thin', addressMode: 'tnsAlias', tnsAlias: 'ORCL', privilege: 'normal',
      netConfigSource: 'default',
    });
    registry.saveOracleSettings({ defaultNetConfigDir: secondNetDir });
    const changed = registry.list().find((value) => value.id === profile.id);
    expect(changed).toMatchObject({
      profileVersion: profile.profileVersion + 1,
      effectiveNetConfigDir: secondNetDir,
    });
    store.close();
  });
});
