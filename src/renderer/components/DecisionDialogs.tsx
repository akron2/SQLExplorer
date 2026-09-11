import { AlertTriangle, FileWarning, X } from 'lucide-react';
import type { SqlDocument } from '../../shared/contracts';

interface CloseDocumentDialogProps {
  document: SqlDocument;
  transactionChanged: boolean;
  onCancel(): void;
  onCommit(): void;
  onDiscard(): void;
  onRollback(): void;
  onSave(): void;
}

export function CloseDocumentDialog({
  document,
  transactionChanged,
  onCancel,
  onCommit,
  onDiscard,
  onRollback,
  onSave,
}: CloseDocumentDialogProps) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog-card decision-dialog" role="alertdialog" aria-modal="true" aria-label={`Закрыть ${document.title}`}>
    <header className="dialog-header"><span className="dialog-icon warning"><AlertTriangle size={18} /></span><div><strong>{transactionChanged ? 'Незавершённая транзакция' : 'Несохранённый SQL'}</strong><small>{document.title}</small></div><button className="icon-button compact" type="button" onClick={onCancel} aria-label="Закрыть"><X size={16} /></button></header>
    <div className="decision-copy">{transactionChanged ? 'Закрытие вкладки завершит её отдельную серверную сессию. Выберите, что сделать с транзакцией.' : 'Документ изменён относительно файла на диске. Сохранить изменения перед закрытием?'}</div>
    <footer className="dialog-actions">{transactionChanged ? <><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="danger-action" type="button" onClick={onRollback}>Rollback и продолжить</button><button className="primary-button" type="button" onClick={onCommit}>Commit и продолжить</button></> : <><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="danger-action" type="button" onClick={onDiscard}>Не сохранять</button><button className="primary-button" type="button" onClick={onSave}>Сохранить</button></>}</footer>
  </section></div>;
}

interface FileConflictDialogProps {
  document: SqlDocument;
  onCancel(): void;
  onCompare(): void;
  onOverwrite(): void;
  onReload(): void;
  onSaveAs(): void;
}

export function FileConflictDialog({ document, onCancel, onCompare, onOverwrite, onReload, onSaveAs }: FileConflictDialogProps) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog-card decision-dialog" role="alertdialog" aria-modal="true" aria-label="Файл изменён на диске">
    <header className="dialog-header"><span className="dialog-icon warning"><FileWarning size={18} /></span><div><strong>Файл изменён на диске</strong><small>{document.filePath}</small></div><button className="icon-button compact" type="button" onClick={onCancel} aria-label="Закрыть"><X size={16} /></button></header>
    <div className="decision-copy">Другая программа изменила файл после открытия. Перезапись может уничтожить эти изменения.</div>
    <footer className="dialog-actions multi-actions"><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="secondary-button" type="button" onClick={onCompare}>Сравнить</button><button className="secondary-button" type="button" onClick={onReload}>Перезагрузить</button><button className="secondary-button" type="button" onClick={onSaveAs}>Сохранить как…</button><button className="danger-action" type="button" onClick={onOverwrite}>Перезаписать</button></footer>
  </section></div>;
}

interface FileComparisonDialogProps {
  diskText: string;
  document: SqlDocument;
  onClose(): void;
}

export function FileComparisonDialog({ diskText, document, onClose }: FileComparisonDialogProps) {
  return <div className="dialog-backdrop comparison-backdrop" role="presentation"><section className="dialog-card comparison-dialog" role="dialog" aria-modal="true" aria-label="Сравнение файла">
    <header className="dialog-header"><span className="dialog-icon"><FileWarning size={18} /></span><div><strong>Локальная версия и файл на диске</strong><small>{document.filePath}</small></div><button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button></header>
    <div className="comparison-grid"><section><strong>В редакторе</strong><pre>{document.text}</pre></section><section><strong>На диске</strong><pre>{diskText}</pre></section></div>
    <footer className="dialog-actions"><button className="primary-button" type="button" onClick={onClose}>Вернуться к выбору</button></footer>
  </section></div>;
}

interface SessionResetDialogProps {
  action: 'disconnect' | 'reconnect';
  onCancel(): void;
  onConfirm(): void;
}

export function SessionResetDialog({ action, onCancel, onConfirm }: SessionResetDialogProps) {
  return <div className="dialog-backdrop" role="presentation"><section className="dialog-card decision-dialog" role="alertdialog" aria-modal="true" aria-label="Незавершённая транзакция">
    <header className="dialog-header"><span className="dialog-icon warning"><AlertTriangle size={18} /></span><div><strong>Незавершённая транзакция</strong><small>{action === 'reconnect' ? 'Переподключение создаст новую серверную сессию' : 'Отключение закроет серверную сессию'}</small></div></header>
    <div className="decision-copy">Несохранённые изменения текущей вкладки будут отменены. Скрытый Commit никогда не выполняется.</div>
    <footer className="dialog-actions"><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="danger-action" type="button" onClick={onConfirm}>Rollback и {action === 'reconnect' ? 'переподключить' : 'отключить'}</button></footer>
  </section></div>;
}
