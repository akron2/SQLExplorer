import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile, PublicConnectionProfile } from '../shared/contracts';
import { defaultConnections } from '../shared/defaults';

interface LocalOracleConfig {
  host?: string;
  ociLibrary?: string;
  password?: string;
  port?: number;
  serviceName?: string;
  username?: string;
}

interface LocalPostgresConfig {
  database?: string;
  host?: string;
  password?: string;
  port?: number;
  username?: string;
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function publicProfile(profile: ConnectionProfile): PublicConnectionProfile {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    color: profile.color,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    serviceName: profile.serviceName,
    username: profile.username,
    status: profile.status,
  };
}

export class ConnectionRegistry {
  readonly #profiles = new Map<string, ConnectionProfile>();

  constructor(projectRoot: string) {
    const oracleDefaults = defaultConnections.find((profile) => profile.kind === 'oracle');
    const postgresDefaults = defaultConnections.find((profile) => profile.kind === 'postgres');

    if (!oracleDefaults || !postgresDefaults) {
      throw new Error('Default connection definitions are incomplete');
    }

    const oracle = readJson<LocalOracleConfig>(
      path.join(projectRoot, '.local', 'oracle', 'connection.json'),
    );
    const postgres = readJson<LocalPostgresConfig>(
      path.join(projectRoot, '.local', 'postgres', 'connection.json'),
    );

    this.#profiles.set('oracle-local', {
      ...oracleDefaults,
      host: oracle?.host ?? oracleDefaults.host,
      port: oracle?.port ?? oracleDefaults.port,
      database: oracle?.serviceName ?? oracleDefaults.database,
      serviceName: oracle?.serviceName ?? oracleDefaults.serviceName,
      username: oracle?.username ?? oracleDefaults.username,
      password: oracle?.password ?? '',
      ociLibrary: oracle?.ociLibrary,
      connectString: `${oracle?.host ?? oracleDefaults.host}:${oracle?.port ?? oracleDefaults.port}/${oracle?.serviceName ?? oracleDefaults.serviceName}`,
      status: oracle?.password ? 'configured' : 'needs-credentials',
    });

    this.#profiles.set('postgres-local', {
      ...postgresDefaults,
      host: postgres?.host ?? postgresDefaults.host,
      port: postgres?.port ?? postgresDefaults.port,
      database: postgres?.database ?? postgresDefaults.database,
      username: postgres?.username ?? postgresDefaults.username,
      password: postgres?.password ?? '',
      status: postgres?.password ? 'configured' : 'needs-credentials',
    });
  }

  get(id: string): ConnectionProfile {
    const profile = this.#profiles.get(id);
    if (!profile) {
      throw new Error(`Unknown connection profile: ${id}`);
    }
    if (!profile.password) {
      throw new Error(`Connection profile ${profile.name} has no configured credentials`);
    }
    return profile;
  }

  list(): PublicConnectionProfile[] {
    return [...this.#profiles.values()].map(publicProfile);
  }
}
