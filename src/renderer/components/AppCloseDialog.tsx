import { AlertTriangle } from 'lucide-react';

interface AppCloseDialogProps {
  dirtyCount: number;
  onCancel(): void;
  onCommitAll(): void;
  onDiscardFiles(): void;
  onRollbackAll(): void;
  onSaveAll(): void;
  phase: 'transactions' | 'files';
  transactionCount: number;
}

export function AppCloseDialog({
  dirtyCount,
  onCancel,
  onCommitAll,
  onDiscardFiles,
  onRollbackAll,
  onSaveAll,
  phase,
  transactionCount,
}: AppCloseDialogProps) {
  const transactions = phase === 'transactions';
  return <div className="dialog-backdrop" role="presentation"><section className="dialog-card decision-dialog" role="alertdialog" aria-modal="true" aria-label="Закрыть SQLExplorer">
    <header className="dialog-header"><span className="dialog-icon warning"><AlertTriangle size={18} /></span><div><strong>Закрыть SQLExplorer?</strong><small>{transactions ? `Незавершённых транзакций: ${transactionCount}` : `Несохранённых документов: ${dirtyCount}`}</small></div></header>
    <div className="decision-copy">{transactions ? 'Каждая вкладка имеет отдельную сессию. Перед закрытием явно выберите Commit или Rollback для всех изменённых транзакций.' : 'Сохранить изменённые SQL-файлы и черновики на диск перед закрытием?'}</div>
    <footer className="dialog-actions">{transactions ? <><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="danger-action" type="button" onClick={onRollbackAll}>Rollback всех</button><button className="primary-button" type="button" onClick={onCommitAll}>Commit всех</button></> : <><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="danger-action" type="button" onClick={onDiscardFiles}>Не сохранять</button><button className="primary-button" type="button" onClick={onSaveAll}>Сохранить все</button></>}</footer>
  </section></div>;
}
