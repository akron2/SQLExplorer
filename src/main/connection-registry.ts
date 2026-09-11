import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  OracleClientDefinition,
  OracleClientInput,
  OracleSettings,
  PublicConnectionProfile,
} from '../shared/contracts';
import { defaultConnections } from '../shared/defaults';
import type { SecretStorage } from './secret-storage';
import type { WorkspaceStore } from './workspace-store';

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

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`Заполните поле «${label}»`);
  return normalized;
}

function normalizedPort(value: number, fallback: number): number {
  const port = Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (port < 1 || port > 65_535) throw new Error('Порт должен быть числом от 1 до 65535');
  return port;
}

function existingDirectory(value: string | undefined, label: string): string {
  const directory = required(value, label);
  try {
    if (fs.statSync(directory).isDirectory()) return directory;
  } catch {
    // A localized validation error is returned below.
  }
  throw new Error(`${label} не существует или недоступен: ${directory}`);
}

function oracleClientDirectory(value: string | undefined): string {
  const requested = required(value, 'Каталог Oracle Client');
  try {
    const stat = fs.statSync(requested);
    if (stat.isDirectory()) return requested;
    if (stat.isFile()) return path.dirname(requested);
  } catch {
    // A localized validation error is returned below.
  }
  throw new Error(`Oracle Client не найден: ${requested}`);
}

function storedProfile(profile: PublicConnectionProfile): PublicConnectionProfile {
  const common: PublicConnectionProfile = {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    color: profile.color,
    username: profile.username,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    credentialState: profile.credentialState,
    profileVersion: profile.profileVersion,
  };
  if (profile.kind === 'oracle') {
    common.driverMode = profile.driverMode;
    common.addressMode = profile.addressMode;
    common.serviceName = profile.serviceName;
    common.tnsAlias = profile.tnsAlias;
    common.connectString = profile.connectString;
    common.netConfigSource = profile.netConfigSource;
    common.netConfigDir = profile.netConfigDir;
    common.oracleClientId = profile.oracleClientId;
    common.privilege = profile.privilege;
  }
  return common;
}

function criticalSignature(profile: PublicConnectionProfile): string {
  return JSON.stringify({
    kind: profile.kind,
    username: profile.username,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    driverMode: profile.driverMode,
    addressMode: profile.addressMode,
    serviceName: profile.serviceName,
    tnsAlias: profile.tnsAlias,
    connectString: profile.connectString,
    netConfigSource: profile.netConfigSource,
    netConfigDir: profile.netConfigDir,
    oracleClientId: profile.oracleClientId,
    privilege: profile.privilege,
  });
}

export class ConnectionRegistry {
  readonly #profiles = new Map<string, PublicConnectionProfile>();
  readonly #sessionPasswords = new Map<string, string>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly secrets: SecretStorage,
    private readonly configRoot: string,
    private readonly importDevelopmentFixtures: boolean,
  ) {}

  async initialize(): Promise<void> {
    for (const stored of this.store.listConnectionProfiles()) {
      const profile: PublicConnectionProfile = stored.kind === 'oracle'
        ? {
            ...stored,
            profileVersion: stored.profileVersion ?? 1,
            driverMode: stored.driverMode ?? 'thin',
            addressMode: stored.addressMode ?? 'basic',
            privilege: stored.privilege ?? 'normal',
            netConfigSource: stored.netConfigSource ?? 'default',
            serviceName: stored.serviceName ?? stored.database,
          }
        : { ...stored, profileVersion: stored.profileVersion ?? 1 };
      const credentialState = this.store.hasEncryptedPassword(profile.id) ? 'saved' : 'missing';
      this.#profiles.set(profile.id, { ...profile, credentialState });
      this.store.saveConnectionProfile(storedProfile({ ...profile, credentialState }));
    }
    if (this.#profiles.size === 0 && this.importDevelopmentFixtures) {
      await this.#importFixtures();
    }
  }

  list(): PublicConnectionProfile[] {
    return [...this.#profiles.values()]
      .map((profile) => this.#withRuntimeDetails(profile))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<ConnectionProfile> {
    const profile = this.#profiles.get(id);
    if (!profile) throw new Error(`Неизвестный профиль соединения: ${id}`);
    const password = await this.#passwordFor(id);
    if (!password) throw new Error(`Для соединения «${profile.name}» не указан пароль`);
    return this.#connectionProfile(profile, password);
  }

  sessionProfile(id: string): ConnectionProfile {
    const profile = this.#profiles.get(id);
    if (!profile) throw new Error(`Неизвестный профиль соединения: ${id}`);
    return this.#connectionProfile(profile, '');
  }

  async profileForTest(input: ConnectionProfileInput): Promise<ConnectionProfile> {
    const existing = input.id ? this.#profiles.get(input.id) : undefined;
    const normalized = this.#normalize(input, existing);
    const password = input.password || (existing ? await this.#passwordFor(existing.id) : undefined);
    if (!password) throw new Error('Введите пароль для проверки соединения');
    return this.#connectionProfile(normalized, password);
  }

  async save(input: ConnectionProfileInput): Promise<PublicConnectionProfile> {
    const existing = input.id ? this.#profiles.get(input.id) : undefined;
    if (existing && existing.kind !== input.kind) {
      throw new Error('Тип БД существующего профиля изменить нельзя; создайте новый профиль');
    }
    const normalized = this.#normalize(input, existing);
    const criticalChanged = existing && (
      criticalSignature(existing) !== criticalSignature(normalized)
      || Boolean(input.password)
      || Boolean(input.clearPassword)
    );
    const profile: PublicConnectionProfile = {
      ...normalized,
      profileVersion: existing ? existing.profileVersion + (criticalChanged ? 1 : 0) : 1,
    };

    if (input.clearPassword) {
      this.#sessionPasswords.delete(profile.id);
      this.store.deleteEncryptedPassword(profile.id);
      profile.credentialState = 'missing';
    } else if (input.password) {
      if (input.rememberPassword && await this.secrets.available()) {
        const encrypted = await this.secrets.encrypt(input.password);
        this.store.saveConnectionProfile(storedProfile({ ...profile, credentialState: 'saved' }));
        this.store.saveEncryptedPassword(profile.id, encrypted);
        this.#sessionPasswords.delete(profile.id);
        profile.credentialState = 'saved';
      } else {
        this.store.deleteEncryptedPassword(profile.id);
        this.#sessionPasswords.set(profile.id, input.password);
        profile.credentialState = 'session';
      }
    } else if (existing) {
      if (!input.rememberPassword && this.store.hasEncryptedPassword(profile.id)) {
        const password = await this.#passwordFor(profile.id);
        this.store.deleteEncryptedPassword(profile.id);
        if (password) this.#sessionPasswords.set(profile.id, password);
        profile.credentialState = password ? 'session' : 'missing';
      } else {
        profile.credentialState = this.store.hasEncryptedPassword(profile.id)
          ? 'saved'
          : this.#sessionPasswords.has(profile.id) ? 'session' : 'missing';
      }
    }

    this.#profiles.set(profile.id, storedProfile(profile));
    this.store.saveConnectionProfile(storedProfile(profile));
    return this.#withRuntimeDetails(profile);
  }

  delete(id: string): void {
    if (!this.#profiles.has(id)) return;
    this.#profiles.delete(id);
    this.#sessionPasswords.delete(id);
    this.store.deleteMetadata(id);
    this.store.deleteConnectionProfile(id);
  }

  oracleSettings(): OracleSettings {
    return this.store.loadOracleSettings();
  }

  saveOracleSettings(settings: OracleSettings): OracleSettings {
    const previous = this.oracleSettings();
    const requested = settings.defaultNetConfigDir.trim();
    const normalized = {
      defaultNetConfigDir: requested ? existingDirectory(requested, 'Каталог Oracle Net') : '',
    };
    this.store.saveOracleSettings(normalized);
    if (previous.defaultNetConfigDir !== normalized.defaultNetConfigDir) {
      this.#bumpProfiles((profile) =>
        profile.kind === 'oracle' && (profile.netConfigSource ?? 'default') === 'default');
    }
    return normalized;
  }

  oracleClients(): OracleClientDefinition[] {
    return this.store.listOracleClients();
  }

  saveOracleClient(input: OracleClientInput): OracleClientDefinition {
    const previous = input.id ? this.oracleClients().find((client) => client.id === input.id) : undefined;
    const client = {
      id: input.id ?? randomUUID(),
      name: required(input.name, 'Название Oracle Client'),
      libDir: oracleClientDirectory(input.libDir),
    };
    this.store.saveOracleClient(client);
    if (previous && previous.libDir !== client.libDir) {
      this.#bumpProfiles((profile) => profile.oracleClientId === client.id);
    }
    return client;
  }

  deleteOracleClient(id: string): void {
    const dependent = [...this.#profiles.values()].find((profile) => profile.oracleClientId === id);
    if (dependent) {
      throw new Error(`Oracle Client используется соединением «${dependent.name}»`);
    }
    this.store.deleteOracleClient(id);
  }

  #normalize(
    input: ConnectionProfileInput,
    existing?: PublicConnectionProfile,
  ): PublicConnectionProfile {
    const id = existing?.id ?? input.id ?? randomUUID();
    const name = required(input.name, 'Название');
    const username = required(input.username, 'Пользователь');
    const color = input.color.trim() || (input.kind === 'oracle' ? '#e36b2c' : '#3676d8');

    if (input.kind === 'postgres') {
      return {
        id, name, username, color, kind: 'postgres',
        host: required(input.host, 'Сервер'),
        port: normalizedPort(input.port, 5432),
        database: required(input.database, 'База данных'),
        credentialState: existing?.credentialState ?? 'missing',
        profileVersion: existing?.profileVersion ?? 1,
      };
    }

    const driverMode = input.driverMode ?? 'thin';
    const addressMode = input.addressMode ?? 'basic';
    const privilege = input.privilege ?? 'normal';
    const netConfigSource = input.netConfigSource ?? 'default';
    const effectiveNetConfigDir = netConfigSource === 'profile'
      ? input.netConfigDir?.trim() ?? ''
      : this.oracleSettings().defaultNetConfigDir;
    if (effectiveNetConfigDir) existingDirectory(effectiveNetConfigDir, 'Каталог Oracle Net');
    if (driverMode === 'thick') {
      const client = this.oracleClients().find((candidate) => candidate.id === input.oracleClientId);
      if (!client) throw new Error('Выберите установленный Oracle Client для Thick mode');
    }

    let host = '';
    let port = 1521;
    let database: string;
    let serviceName: string | undefined;
    let tnsAlias: string | undefined;
    let connectString: string | undefined;
    if (addressMode === 'basic') {
      host = required(input.host, 'Сервер');
      port = normalizedPort(input.port, 1521);
      serviceName = required(input.serviceName || input.database, 'Service name');
      database = serviceName;
    } else if (addressMode === 'tnsAlias') {
      tnsAlias = required(input.tnsAlias || input.database, 'TNS alias');
      database = tnsAlias;
      if (!effectiveNetConfigDir) throw new Error('Укажите каталог Oracle Net с tnsnames.ora');
      if (!fs.existsSync(path.join(effectiveNetConfigDir, 'tnsnames.ora'))) {
        throw new Error(`В каталоге Oracle Net не найден tnsnames.ora: ${effectiveNetConfigDir}`);
      }
    } else {
      connectString = required(input.connectString || input.database, 'Connect string');
      database = connectString;
    }

    return {
      id, name, username, color, kind: 'oracle', host, port, database,
      serviceName, tnsAlias, connectString, driverMode, addressMode, privilege,
      netConfigSource, netConfigDir: netConfigSource === 'profile' ? effectiveNetConfigDir : undefined,
      oracleClientId: driverMode === 'thick' ? input.oracleClientId : undefined,
      credentialState: existing?.credentialState ?? 'missing',
      profileVersion: existing?.profileVersion ?? 1,
    };
  }

  #withRuntimeDetails(profile: PublicConnectionProfile): PublicConnectionProfile {
    if (profile.kind !== 'oracle') return { ...profile };
    const settings = this.oracleSettings();
    const client = this.oracleClients().find((candidate) => candidate.id === profile.oracleClientId);
    return {
      ...profile,
      effectiveNetConfigDir: profile.netConfigSource === 'profile'
        ? profile.netConfigDir
        : settings.defaultNetConfigDir || undefined,
      oracleClientName: client?.name,
    };
  }

  #connectionProfile(profile: PublicConnectionProfile, password: string): ConnectionProfile {
    const publicProfile = this.#withRuntimeDetails(profile);
    const client = profile.kind === 'oracle'
      ? this.oracleClients().find((candidate) => candidate.id === profile.oracleClientId)
      : undefined;
    return { ...publicProfile, password, oracleClientLibDir: client?.libDir };
  }

  async #passwordFor(profileId: string): Promise<string | undefined> {
    const sessionPassword = this.#sessionPasswords.get(profileId);
    if (sessionPassword) return sessionPassword;
    const encrypted = this.store.loadEncryptedPassword(profileId);
    if (!encrypted) return undefined;
    if (!await this.secrets.available()) {
      throw new Error('Защищённое хранилище паролей временно недоступно');
    }
    const decrypted = await this.secrets.decrypt(encrypted);
    this.#sessionPasswords.set(profileId, decrypted);
    return decrypted;
  }

  #bumpProfiles(predicate: (profile: PublicConnectionProfile) => boolean): void {
    for (const [id, profile] of this.#profiles) {
      if (!predicate(profile)) continue;
      const next = { ...profile, profileVersion: profile.profileVersion + 1 };
      this.#profiles.set(id, next);
      this.store.saveConnectionProfile(storedProfile(next));
    }
  }

  async #importFixtures(): Promise<void> {
    const oracleDefaults = defaultConnections.find((profile) => profile.kind === 'oracle');
    const postgresDefaults = defaultConnections.find((profile) => profile.kind === 'postgres');
    if (!oracleDefaults || !postgresDefaults) return;
    const oracle = readJson<LocalOracleConfig>(path.join(this.configRoot, '.local', 'oracle', 'connection.json'));
    const postgres = readJson<LocalPostgresConfig>(path.join(this.configRoot, '.local', 'postgres', 'connection.json'));

    if (oracle) {
      if (oracle.ociLibrary) {
        const libDir = path.extname(oracle.ociLibrary) ? path.dirname(oracle.ociLibrary) : oracle.ociLibrary;
        this.saveOracleClient({ id: 'oracle-local-client', name: 'Oracle Client local', libDir });
      }
      await this.save({
        id: 'oracle-local', kind: 'oracle', name: oracleDefaults.name, color: oracleDefaults.color,
        host: oracle.host ?? oracleDefaults.host, port: oracle.port ?? oracleDefaults.port,
        database: oracle.serviceName ?? oracleDefaults.database,
        serviceName: oracle.serviceName ?? oracleDefaults.serviceName,
        username: oracle.username ?? oracleDefaults.username,
        password: oracle.password, rememberPassword: Boolean(oracle.password),
        driverMode: 'thin', addressMode: 'basic', privilege: 'normal', netConfigSource: 'default',
      });
    }
    if (postgres) {
      await this.save({
        id: 'postgres-local', kind: 'postgres', name: postgresDefaults.name, color: postgresDefaults.color,
        host: postgres.host ?? postgresDefaults.host, port: postgres.port ?? postgresDefaults.port,
        database: postgres.database ?? postgresDefaults.database,
        username: postgres.username ?? postgresDefaults.username,
        password: postgres.password, rememberPassword: Boolean(postgres.password),
      });
    }
  }
}
