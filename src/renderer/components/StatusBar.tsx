import { ShieldAlert } from 'lucide-react';
import type {
  CursorPosition,
  PublicConnectionProfile,
  SessionState,
  SqlDocument,
  TextFileEol,
} from '../../shared/contracts';

interface StatusBarProps {
  connection?: PublicConnectionProfile;
  cursor: CursorPosition;
  document: SqlDocument;
  documentCount: number;
  onChangeEol(eol: TextFileEol): void;
  onOpenEncoding(): void;
  session?: SessionState;
  transactionChanged: boolean;
}

const labels: Record<SessionState['status'], string> = {
  disconnected: 'не подключено', connecting: 'подключение…', connected: 'подключено',
  lost: 'связь потеряна', outdated: 'нужно переподключить', error: 'ошибка подключения',
};

export function StatusBar({
  connection,
  cursor,
  document,
  documentCount,
  onChangeEol,
  onOpenEncoding,
  session,
  transactionChanged,
}: StatusBarProps) {
  const status = session?.status ?? 'disconnected';
  const details = session?.error?.message
    ?? (session?.lastActivityAt ? `Последняя успешная операция: ${new Date(session.lastActivityAt).toLocaleString()}` : undefined);
  return (
    <footer className="status-bar">
      <span className={`server-status ${status}`} title={details}>
        <i /> {connection ? `${connection.kind === 'oracle' ? 'Oracle' : 'PostgreSQL'} · ${connection.name} · ${labels[status]}` : 'Без соединения'}
      </span>
      {connection?.driverMode && <span>{connection.driverMode.toUpperCase()}</span>}
      {connection?.privilege === 'sysdba' && <span className="status-sysdba"><ShieldAlert size={11} /> SYSDBA</span>}
      <span className="status-spacer" />
      <button className="status-action" type="button" onClick={onOpenEncoding} title="Открыть повторно или сохранить с другой кодировкой">{document.encoding.toUpperCase()}{document.bom !== 'none' ? ' + BOM' : ''}</button>
      <select className="status-select" aria-label="Переводы строк" value={document.eol} onChange={(event) => onChangeEol(event.target.value as TextFileEol)}><option value="crlf">CRLF</option><option value="lf">LF</option><option value="cr">CR</option></select>
      <span>Стр {cursor.lineNumber}, ст {cursor.column}</span>
      <span>{documentCount} док.</span>
      <span>Ручной commit</span>
      <span>{transactionChanged ? 'Есть изменения' : session?.transactionState === 'lost' ? 'Транзакция потеряна' : 'Изменений нет'}</span>
    </footer>
  );
}
