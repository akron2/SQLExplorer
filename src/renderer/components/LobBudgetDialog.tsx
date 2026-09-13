import { AlertTriangle } from 'lucide-react';
import type { LobBudgetRequest } from '../../shared/contracts';
import { LOB_BUDGET_STEP_BYTES, formatByteSize } from '../../shared/lob';

interface LobBudgetDialogProps {
  onAllow(): void;
  onDecline(): void;
  request: LobBudgetRequest;
}

export function LobBudgetDialog({ onAllow, onDecline, request }: LobBudgetDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card decision-dialog" role="alertdialog" aria-modal="true" aria-label="Лимит памяти для больших значений">
        <header className="dialog-header">
          <span className="dialog-icon warning"><AlertTriangle size={18} /></span>
          <div>
            <strong>Лимит памяти для больших значений</strong>
            <small>PostgreSQL уже загрузил значения в память процесса соединения</small>
          </div>
        </header>
        <div className="decision-copy">
          Занято {formatByteSize(request.usedBytes)} из {formatByteSize(request.capBytes)},
          для следующего значения нужно ещё {formatByteSize(request.requiredBytes)}.
          Разрешить дополнительный бюджет {formatByteSize(LOB_BUDGET_STEP_BYTES)}?
          Дальнейший рост памяти повышает риск падения процесса соединения.
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onDecline}>Не загружать</button>
          <button className="primary-button" type="button" onClick={onAllow}>Загрузить ещё 256 МиБ</button>
        </footer>
      </section>
    </div>
  );
}
