import type { CursorPosition, PublicConnectionProfile } from '../../shared/contracts';

interface StatusBarProps {
  connection: PublicConnectionProfile;
  cursor: CursorPosition;
  documentCount: number;
  transactionChanged: boolean;
}

export function StatusBar({ connection, cursor, documentCount, transactionChanged }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span className="server-status">
        <i /> {connection.kind === 'oracle' ? 'Oracle' : 'PostgreSQL'} · {connection.host}:{connection.port}
      </span>
      <span className="status-spacer" />
      <span>Стр {cursor.lineNumber}, ст {cursor.column}</span>
      <span>{documentCount} док.</span>
      <span>Ручной commit</span>
      <span>{transactionChanged ? 'Есть изменения' : 'Изменений нет'}</span>
    </footer>
  );
}
