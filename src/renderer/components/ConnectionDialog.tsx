import { useMemo, useState } from 'react';
import { Database, FolderOpen, LoaderCircle, ShieldAlert, X } from 'lucide-react';
import type {
  ConnectionProfileInput,
  ConnectionTestResult,
  OracleClientDefinition,
  OracleSettings,
  PublicConnectionProfile,
} from '../../shared/contracts';

interface ConnectionDialogProps {
  onChooseDirectory(defaultPath?: string): Promise<string | undefined>;
  onClose(): void;
  onListTnsAliases(configDir: string): Promise<string[]>;
  onOpenOracleSettings(): void;
  onSave(input: ConnectionProfileInput): Promise<void>;
  onTest(input: ConnectionProfileInput): Promise<ConnectionTestResult>;
  oracleClients: OracleClientDefinition[];
  oracleSettings: OracleSettings;
  profile?: PublicConnectionProfile;
}

function draftFor(profile?: PublicConnectionProfile): ConnectionProfileInput {
  if (profile) {
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      color: profile.color,
      username: profile.username,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      serviceName: profile.serviceName,
      driverMode: profile.driverMode ?? 'thin',
      addressMode: profile.addressMode ?? 'basic',
      tnsAlias: profile.tnsAlias,
      connectString: profile.connectString,
      privilege: profile.privilege ?? 'normal',
      netConfigSource: profile.netConfigSource ?? 'default',
      netConfigDir: profile.netConfigDir,
      oracleClientId: profile.oracleClientId,
      rememberPassword: profile.credentialState === 'saved',
    };
  }
  return {
    name: '', kind: 'oracle', color: '#e36b2c', username: '', host: '127.0.0.1', port: 1521,
    database: '', serviceName: '', driverMode: 'thin', addressMode: 'basic', privilege: 'normal',
    netConfigSource: 'default', rememberPassword: true,
  };
}

function prepared(draft: ConnectionProfileInput): ConnectionProfileInput {
  if (draft.kind !== 'oracle') return draft;
  const database = draft.addressMode === 'tnsAlias'
    ? draft.tnsAlias ?? ''
    : draft.addressMode === 'connectString'
      ? draft.connectString ?? ''
      : draft.serviceName ?? '';
  return { ...draft, database };
}

export function ConnectionDialog({
  onChooseDirectory,
  onClose,
  onListTnsAliases,
  onOpenOracleSettings,
  onSave,
  onTest,
  oracleClients,
  oracleSettings,
  profile,
}: ConnectionDialogProps) {
  const [draft, setDraft] = useState(() => draftFor(profile));
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string }>();
  const [aliases, setAliases] = useState<string[]>([]);
  const effectiveNetDir = draft.netConfigSource === 'profile'
    ? draft.netConfigDir ?? ''
    : oracleSettings.defaultNetConfigDir;
  const title = profile ? `Соединение: ${profile.name}` : 'Новое соединение';
  const selectedClient = useMemo(
    () => oracleClients.find((client) => client.id === draft.oracleClientId),
    [draft.oracleClientId, oracleClients],
  );

  const update = <K extends keyof ConnectionProfileInput>(key: K, value: ConnectionProfileInput[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(undefined);
  };

  const run = async (action: 'save' | 'test') => {
    setBusy(action);
    setMessage(undefined);
    try {
      const input = prepared(draft);
      if (action === 'test') {
        const result = await onTest(input);
        const details = [
          result.driverMode ? result.driverMode.toUpperCase() : undefined,
          result.oracleClientVersion ? `Client ${result.oracleClientVersion}` : undefined,
          `${Math.round(result.elapsedMs)} мс`,
        ].filter(Boolean).join(' · ');
        setMessage({ kind: 'success', text: `${result.serverVersion}${details ? ` · ${details}` : ''}` });
      } else {
        await onSave(input);
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const loadAliases = async () => {
    if (!effectiveNetDir) {
      setMessage({ kind: 'error', text: 'Сначала укажите каталог Oracle Net' });
      return;
    }
    setBusy('test');
    try {
      const values = await onListTnsAliases(effectiveNetDir);
      setAliases(values);
      setMessage({ kind: 'success', text: `Найдено алиасов: ${values.length}` });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card connection-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-header">
          <span className="dialog-icon"><Database size={18} /></span>
          <div><strong>{title}</strong><small>Профиль хранится отдельно от физических сессий</small></div>
          <button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>

        <form onSubmit={(event) => { event.preventDefault(); void run('save'); }}>
          <div className="form-grid two-columns">
            <label><span>Название</span><input aria-label="Название соединения" value={draft.name} onChange={(event) => update('name', event.target.value)} autoFocus /></label>
            <label><span>Тип БД</span><select aria-label="Тип базы данных" value={draft.kind} disabled={Boolean(profile)} onChange={(event) => {
              const kind = event.target.value as ConnectionProfileInput['kind'];
              setDraft((current) => ({
                ...current, kind, color: kind === 'oracle' ? '#e36b2c' : '#3676d8',
                port: kind === 'oracle' ? 1521 : 5432,
              }));
            }}><option value="oracle">Oracle</option><option value="postgres">PostgreSQL</option></select></label>
            <label><span>Пользователь</span><input aria-label="Пользователь" value={draft.username} onChange={(event) => update('username', event.target.value)} /></label>
            <label><span>Пароль</span><input aria-label="Пароль" type="password" disabled={Boolean(draft.clearPassword)} value={draft.password ?? ''} placeholder={profile?.credentialState === 'saved' ? 'Сохранён — оставьте пустым' : ''} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value, clearPassword: false }))} /></label>
          </div>

          <div className="form-inline-options">
            <label className="check-label"><input type="checkbox" disabled={Boolean(draft.clearPassword)} checked={draft.rememberPassword} onChange={(event) => update('rememberPassword', event.target.checked)} /> Запомнить пароль защищённо</label>
            {profile && profile.credentialState !== 'missing' && (
              <label className="check-label danger-check"><input type="checkbox" checked={Boolean(draft.clearPassword)} onChange={(event) => setDraft((current) => ({ ...current, clearPassword: event.target.checked, password: event.target.checked ? '' : current.password }))} /> Удалить сохранённый пароль</label>
            )}
            <label className="color-label"><span>Цвет</span><input aria-label="Цвет соединения" type="color" value={draft.color} onChange={(event) => update('color', event.target.value)} /></label>
          </div>

          {draft.kind === 'postgres' ? (
            <fieldset><legend>PostgreSQL</legend><div className="form-grid three-columns">
              <label><span>Сервер</span><input aria-label="Сервер PostgreSQL" value={draft.host} onChange={(event) => update('host', event.target.value)} /></label>
              <label><span>Порт</span><input aria-label="Порт PostgreSQL" type="number" value={draft.port} onChange={(event) => update('port', Number(event.target.value))} /></label>
              <label><span>База данных</span><input aria-label="База данных PostgreSQL" value={draft.database} onChange={(event) => update('database', event.target.value)} /></label>
            </div></fieldset>
          ) : (
            <>
              <fieldset><legend>Oracle runtime</legend><div className="form-grid three-columns">
                <label><span>Драйвер</span><select aria-label="Режим Oracle" value={draft.driverMode} onChange={(event) => update('driverMode', event.target.value as 'thin' | 'thick')}><option value="thin">Thin</option><option value="thick">Thick</option></select></label>
                <label><span>Привилегия</span><select aria-label="Привилегия Oracle" value={draft.privilege} onChange={(event) => update('privilege', event.target.value as 'normal' | 'sysdba')}><option value="normal">Обычная</option><option value="sysdba">SYSDBA</option></select></label>
                <label><span>Адресация</span><select aria-label="Адресация Oracle" value={draft.addressMode} onChange={(event) => update('addressMode', event.target.value as ConnectionProfileInput['addressMode'])}><option value="basic">Host / Port / Service</option><option value="tnsAlias">TNS alias</option><option value="connectString">Connect string</option></select></label>
              </div>
              {draft.privilege === 'sysdba' && <div className="inline-warning"><ShieldAlert size={15} /> Все вкладки этого профиля получат административную привилегию SYSDBA.</div>}
              {draft.driverMode === 'thick' && <div className="form-grid client-row">
                <label><span>Oracle Client</span><select aria-label="Oracle Client" value={draft.oracleClientId ?? ''} onChange={(event) => update('oracleClientId', event.target.value)}><option value="">Не выбран</option>{oracleClients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
                <div className="field-summary"><span>{selectedClient?.libDir ?? 'Добавьте путь к установленному Oracle Client'}</span><button className="secondary-button" type="button" onClick={onOpenOracleSettings}>Настроить…</button></div>
              </div>}
              </fieldset>

              <fieldset><legend>Oracle Net configuration</legend>
                <div className="form-grid two-columns">
                  <label><span>Источник каталога</span><select aria-label="Источник каталога Oracle Net" value={draft.netConfigSource} onChange={(event) => update('netConfigSource', event.target.value as 'default' | 'profile')}><option value="default">Глобальная настройка</option><option value="profile">Для этого профиля</option></select></label>
                  <label><span>Эффективный каталог</span><div className="path-picker"><input aria-label="Каталог Oracle Net" value={effectiveNetDir} readOnly={draft.netConfigSource !== 'profile'} onChange={(event) => update('netConfigDir', event.target.value)} placeholder="Каталог с tnsnames.ora / sqlnet.ora" /><button className="secondary-button" type="button" onClick={() => { void onChooseDirectory(effectiveNetDir).then((value) => { if (value) { setDraft((current) => ({ ...current, netConfigSource: 'profile', netConfigDir: value })); } }); }}><FolderOpen size={14} /> Выбрать</button></div></label>
                </div>
              </fieldset>

              <fieldset><legend>Адрес Oracle</legend>
                {draft.addressMode === 'basic' && <div className="form-grid three-columns">
                  <label><span>Сервер</span><input aria-label="Сервер Oracle" value={draft.host} onChange={(event) => update('host', event.target.value)} /></label>
                  <label><span>Порт</span><input aria-label="Порт Oracle" type="number" value={draft.port} onChange={(event) => update('port', Number(event.target.value))} /></label>
                  <label><span>Service name</span><input aria-label="Service name" value={draft.serviceName ?? ''} onChange={(event) => update('serviceName', event.target.value)} /></label>
                </div>}
                {draft.addressMode === 'connectString' && <label><span>Connect string</span><textarea aria-label="Connect string" rows={3} value={draft.connectString ?? ''} onChange={(event) => update('connectString', event.target.value)} placeholder="host:1521/service или (DESCRIPTION=...)" /></label>}
                {draft.addressMode === 'tnsAlias' && <div className="tns-fields"><label><span>TNS alias</span><div className="path-picker">{aliases.length ? <select aria-label="TNS alias" value={draft.tnsAlias ?? ''} onChange={(event) => update('tnsAlias', event.target.value)}><option value="">Выберите alias</option>{aliases.map((alias) => <option key={alias}>{alias}</option>)}</select> : <input aria-label="TNS alias" value={draft.tnsAlias ?? ''} onChange={(event) => update('tnsAlias', event.target.value)} />}<button className="secondary-button" type="button" onClick={() => { void loadAliases(); }}>Обновить алиасы</button></div></label></div>}
              </fieldset>
            </>
          )}

          {message && <div className={`dialog-message ${message.kind}`}>{message.text}</div>}
          <footer className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Отмена</button>
            <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => { void run('test'); }}>{busy === 'test' && <LoaderCircle className="spin" size={14} />} Проверить</button>
            <button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === 'save' && <LoaderCircle className="spin" size={14} />} Сохранить</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
