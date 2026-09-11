import { useState } from 'react';
import { FolderOpen, Plus, Settings2, Trash2, X } from 'lucide-react';
import type { OracleClientDefinition, OracleSettings } from '../../shared/contracts';

interface OracleSettingsDialogProps {
  clients: OracleClientDefinition[];
  onChooseDirectory(defaultPath?: string): Promise<string | undefined>;
  onClose(): void;
  onDeleteClient(id: string): Promise<void>;
  onSaveClient(client: { id?: string; libDir: string; name: string }): Promise<void>;
  onSaveSettings(settings: OracleSettings): Promise<void>;
  settings: OracleSettings;
}

export function OracleSettingsDialog({
  clients,
  onChooseDirectory,
  onClose,
  onDeleteClient,
  onSaveClient,
  onSaveSettings,
  settings,
}: OracleSettingsDialogProps) {
  const [netDir, setNetDir] = useState(settings.defaultNetConfigDir);
  const [rows, setRows] = useState(() => clients.map((client) => ({ ...client })));
  const [newClient, setNewClient] = useState({ name: '', libDir: '' });
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const saveAll = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await onSaveSettings({ defaultNetConfigDir: netDir });
      for (const row of rows) await onSaveClient(row);
      if (newClient.name.trim() || newClient.libDir.trim()) await onSaveClient(newClient);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog-card settings-dialog" role="dialog" aria-modal="true" aria-label="Настройки Oracle">
      <header className="dialog-header"><span className="dialog-icon"><Settings2 size={18} /></span><div><strong>Настройки Oracle</strong><small>Приложение читает Oracle Net files, но не изменяет их</small></div><button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button></header>
      <div className="settings-content">
        <fieldset><legend>Oracle Net по умолчанию</legend><label><span>Каталог с tnsnames.ora</span><div className="path-picker"><input aria-label="Глобальный каталог Oracle Net" value={netDir} onChange={(event) => setNetDir(event.target.value)} /><button className="secondary-button" type="button" onClick={() => { void onChooseDirectory(netDir).then((value) => { if (value) setNetDir(value); }); }}><FolderOpen size={14} /> Выбрать</button></div></label></fieldset>
        <fieldset><legend>Установленные Oracle Client</legend>
          <div className="client-list">
            {rows.map((client, index) => <div className="client-editor-row" key={client.id}>
              <input aria-label={`Название Oracle Client ${index + 1}`} value={client.name} onChange={(event) => setRows((current) => current.map((row) => row.id === client.id ? { ...row, name: event.target.value } : row))} placeholder="Название" />
              <input aria-label={`Путь Oracle Client ${index + 1}`} value={client.libDir} onChange={(event) => setRows((current) => current.map((row) => row.id === client.id ? { ...row, libDir: event.target.value } : row))} placeholder="libDir" />
              <button className="icon-button compact" type="button" title="Выбрать каталог" onClick={() => { void onChooseDirectory(client.libDir).then((value) => { if (value) setRows((current) => current.map((row) => row.id === client.id ? { ...row, libDir: value } : row)); }); }}><FolderOpen size={14} /></button>
              <button className="icon-button compact danger-button" type="button" title="Удалить Oracle Client" onClick={() => { if (!window.confirm(`Удалить Oracle Client «${client.name}»?`)) return; void onDeleteClient(client.id).then(() => setRows((current) => current.filter((row) => row.id !== client.id))).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))); }}><Trash2 size={14} /></button>
            </div>)}
            <div className="client-editor-row new-client"><input aria-label="Название нового Oracle Client" value={newClient.name} onChange={(event) => setNewClient((current) => ({ ...current, name: event.target.value }))} placeholder="Новый Oracle Client" /><input aria-label="Путь нового Oracle Client" value={newClient.libDir} onChange={(event) => setNewClient((current) => ({ ...current, libDir: event.target.value }))} placeholder="Каталог библиотек" /><button className="icon-button compact" type="button" title="Выбрать каталог" onClick={() => { void onChooseDirectory(newClient.libDir).then((value) => { if (value) setNewClient((current) => ({ ...current, libDir: value })); }); }}><FolderOpen size={14} /></button><span className="new-client-mark"><Plus size={14} /></span></div>
          </div>
        </fieldset>
        {message && <div className="dialog-message error">{message}</div>}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Отмена</button><button className="primary-button" type="button" disabled={busy} onClick={() => { void saveAll(); }}>Сохранить настройки</button></footer>
    </section>
  </div>;
}
