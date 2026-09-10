import { Check, ChevronDown, ListFilter, Play, RotateCcw, Square } from 'lucide-react';
import type { ExecutionStatus, PublicConnectionProfile } from '../../shared/contracts';

interface ExecutionToolbarProps {
  connection: PublicConnectionProfile;
  connections: PublicConnectionProfile[];
  status: ExecutionStatus;
  transactionChanged: boolean;
  onCancel(): void;
  onChangeConnection(connectionId: string): void;
  onCommit(): void;
  onExecute(): void;
  onRollback(): void;
  onSuggestions(): void;
}

export function ExecutionToolbar({
  connection,
  connections,
  status,
  transactionChanged,
  onCancel,
  onChangeConnection,
  onCommit,
  onExecute,
  onRollback,
  onSuggestions,
}: ExecutionToolbarProps) {
  const running = ['queued', 'running', 'fetching', 'cancel-requested'].includes(status);
  return (
    <div className="execution-toolbar">
      <button
        className={`run-button ${running ? 'is-running' : ''}`}
        type="button"
        onClick={running ? onCancel : onExecute}
      >
        {running ? <Square size={14} fill="currentColor" /> : <Play size={15} />}
        {running ? (status === 'cancel-requested' ? 'Остановка…' : 'Остановить') : 'Выполнить'}
        <kbd>F8</kbd>
      </button>
      <button className="toolbar-button" type="button" onClick={onCommit} disabled={!transactionChanged || running}>
        <Check size={15} /> Commit
      </button>
      <button className="toolbar-button" type="button" onClick={onRollback} disabled={!transactionChanged || running}>
        <RotateCcw size={15} /> Rollback
      </button>
      <button className="suggestions-button" type="button" onClick={onSuggestions}>
        <ListFilter size={15} /> Подсказки <kbd>F6</kbd>
      </button>
      <label className="connection-selector">
        <span
          className={`dialect-badge ${connection.kind}`}
          style={{ '--connection-color': connection.color } as React.CSSProperties}
        >
          {connection.kind === 'oracle' ? 'O' : 'P'}
        </span>
        <select
          value={connection.id}
          onChange={(event) => onChangeConnection(event.target.value)}
          disabled={running}
          aria-label="Соединение документа"
        >
          {connections.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
          ))}
        </select>
        <span className="connection-user">· {connection.username || 'не настроено'}</span>
        <ChevronDown size={14} />
      </label>
    </div>
  );
}
