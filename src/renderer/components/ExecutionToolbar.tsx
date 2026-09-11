import {
  Check,
  ChevronDown,
  ListFilter,
  LoaderCircle,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Square,
  Unplug,
} from 'lucide-react';
import type { ExecutionStatus, PublicConnectionProfile, SessionState } from '../../shared/contracts';

interface ExecutionToolbarProps {
  connection?: PublicConnectionProfile;
  connections: PublicConnectionProfile[];
  onCancel(): void;
  onChangeConnection(connectionId: string | null): void;
  onCommit(): void;
  onConnect(): void;
  onDisconnect(): void;
  onExecute(): void;
  onReconnect(): void;
  onRollback(): void;
  onSuggestions(): void;
  session?: SessionState;
  status: ExecutionStatus;
  transactionChanged: boolean;
}

const statusLabels: Record<SessionState['status'], string> = {
  disconnected: 'Не подключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  lost: 'Связь потеряна',
  outdated: 'Профиль изменён',
  error: 'Ошибка подключения',
};

export function ExecutionToolbar({
  connection,
  connections,
  status,
  transactionChanged,
  session,
  onCancel,
  onChangeConnection,
  onCommit,
  onConnect,
  onDisconnect,
  onExecute,
  onReconnect,
  onRollback,
  onSuggestions,
}: ExecutionToolbarProps) {
  const running = ['queued', 'running', 'fetching', 'cancel-requested'].includes(status);
  const sessionStatus = session?.status ?? 'disconnected';
  const connected = sessionStatus === 'connected' || sessionStatus === 'outdated';
  const sessionDetails = session?.error?.message
    ?? (session?.lastActivityAt ? `Последняя успешная операция: ${new Date(session.lastActivityAt).toLocaleString()}` : undefined);
  return (
    <div className="execution-toolbar">
      <button className={`run-button ${running ? 'is-running' : ''}`} type="button" onClick={running ? onCancel : onExecute} disabled={!connection}>
        {running ? <Square size={14} fill="currentColor" /> : <Play size={15} />}
        {running ? (status === 'cancel-requested' ? 'Остановка…' : 'Остановить') : 'Выполнить'}
        <kbd>F8</kbd>
      </button>
      <button className="toolbar-button" type="button" onClick={onCommit} disabled={!transactionChanged || running}><Check size={15} /> Commit</button>
      <button className="toolbar-button" type="button" onClick={onRollback} disabled={!transactionChanged || running}><RotateCcw size={15} /> Rollback</button>
      <button className="suggestions-button" type="button" onClick={onSuggestions}><ListFilter size={15} /> Подсказки <kbd>F6</kbd></button>
      <div className="connection-runtime-actions">
        {sessionStatus === 'connecting' ? <button className="connection-action" type="button" disabled><LoaderCircle className="spin" size={14} /> Подключение…</button>
          : connected ? <>
            <button className="icon-button compact" type="button" onClick={onReconnect} disabled={running} title="Переподключить" aria-label="Переподключить"><RefreshCw size={14} /></button>
            <button className="icon-button compact" type="button" onClick={onDisconnect} disabled={running} title="Отключить" aria-label="Отключить"><Unplug size={14} /></button>
          </> : <button className="connection-action" type="button" onClick={onConnect} disabled={!connection || running}><Plug size={14} /> {sessionStatus === 'lost' || sessionStatus === 'error' ? 'Подключить снова' : 'Подключить'}</button>}
      </div>
      <label className={`connection-selector session-${sessionStatus}`}>
        {connection ? <span className={`dialect-badge ${connection.kind}`} style={{ '--connection-color': connection.color } as React.CSSProperties}>{connection.kind === 'oracle' ? 'O' : 'P'}</span> : <span className="dialect-badge sql">S</span>}
        <select value={connection?.id ?? ''} onChange={(event) => onChangeConnection(event.target.value || null)} disabled={running} aria-label="Соединение документа">
          <option value="">Без соединения</option>
          {connections.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        {connection?.driverMode && <span className="runtime-badge">{connection.driverMode}</span>}
        {connection?.privilege === 'sysdba' && <span className="sysdba-badge"><ShieldAlert size={12} /> SYSDBA</span>}
        <span className={`session-dot ${sessionStatus}`} />
        <span className="session-label" title={sessionDetails}>{statusLabels[sessionStatus]}</span>
        <ChevronDown size={14} />
      </label>
    </div>
  );
}
