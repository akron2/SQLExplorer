import { useState } from 'react';
import { FileSpreadsheet, LoaderCircle, X } from 'lucide-react';
import type { ExcelExportOptions, ExcelExportResult, ExcelLobMode } from '../../shared/contracts';
import { LOB_EXCEL_CELL_LIMIT } from '../../shared/lob';

export interface ExcelExportRequest {
  loadAll: boolean;
  options: ExcelExportOptions;
}

interface ExcelExportDialogProps {
  hasMore: boolean;
  loadedRows: number;
  onCancel(): void;
  onConfirm(request: ExcelExportRequest): void;
  phase: 'done' | 'error' | 'options' | 'working';
  progress: string;
  error?: string | undefined;
  result?: ExcelExportResult | undefined;
}

const MODE_LABELS: Array<{ description: string; label: string; value: ExcelLobMode }> = [
  {
    value: 'markers',
    label: 'Только отметки',
    description: 'В ячейке будет [CLOB 1,2 МБ], содержимое LOB не выгружается.',
  },
  {
    value: 'partial',
    label: 'Текстовые LOB частично',
    description: `До ${LOB_EXCEL_CELL_LIMIT.toLocaleString('ru-RU')} символов текста в ячейке; бинарные LOB — отметкой.`,
  },
  {
    value: 'files',
    label: 'Каждый LOB отдельным файлом',
    description: 'Файлы в подкаталоге .lobs рядом с книгой, в ячейке относительная ссылка.',
  },
];

export function ExcelExportDialog({
  error,
  hasMore,
  loadedRows,
  onCancel,
  onConfirm,
  phase,
  progress,
  result,
}: ExcelExportDialogProps) {
  const [lobMode, setLobMode] = useState<ExcelLobMode>('markers');
  const [loadAll, setLoadAll] = useState(hasMore);
  const working = phase === 'working';

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card excel-export-dialog" role="dialog" aria-modal="true" aria-label="Экспорт в Excel">
        <header className="dialog-header">
          <span className="dialog-icon"><FileSpreadsheet size={18} /></span>
          <div>
            <strong>Экспорт в Excel</strong>
            <small>Загружено строк: {loadedRows.toLocaleString('ru-RU')}{result ? ` · экспортировано: ${result.rows.toLocaleString('ru-RU')}` : ''}</small>
          </div>
          <button className="icon-button compact" type="button" onClick={onCancel} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <div className="excel-export-content">
          {phase === 'options' && (
            <>
              <fieldset className="excel-modes">
                <legend>Обработка LOB</legend>
                {MODE_LABELS.map((mode) => (
                  <label key={mode.value} className="excel-mode">
                    <input
                      type="radio"
                      name="excel-lob-mode"
                      checked={lobMode === mode.value}
                      onChange={() => setLobMode(mode.value)}
                    />
                    <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
                  </label>
                ))}
              </fieldset>
              {hasMore && (
                <label className="excel-load-all">
                  <input type="checkbox" checked={loadAll} onChange={(event) => setLoadAll(event.target.checked)} />
                  <span>Загрузить оставшиеся строки перед экспортом (сейчас загружено {loadedRows.toLocaleString('ru-RU')})</span>
                </label>
              )}
              <p className="excel-hint">
                Ограничения Excel: до 32 767 символов в ячейке, лимит строк делится на листы автоматически.
                Книга сохранится в выбранный файл .xlsx.
              </p>
            </>
          )}
          {working && (
            <div className="excel-progress">
              <LoaderCircle className="spin" size={20} />
              <span>{progress}</span>
            </div>
          )}
          {phase === 'done' && result && (
            <div className="excel-result">
              <p>Файл: {result.filePath}</p>
              <p>Строк: {result.rows.toLocaleString('ru-RU')} · файлов LOB: {result.lobFiles.toLocaleString('ru-RU')}</p>
              {result.warnings.length > 0 && (
                <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              )}
            </div>
          )}
          {phase === 'error' && <div className="dialog-message error">{error ?? 'Экспорт не удался'}</div>}
        </div>
        <footer className="dialog-actions">
          {phase === 'options' && (
            <>
              <button className="secondary-button" type="button" onClick={onCancel}>Отмена</button>
              <button className="primary-button" type="button" onClick={() => onConfirm({ loadAll, options: { lobMode } })}>
                Экспортировать
              </button>
            </>
          )}
          {working && <button className="secondary-button" type="button" onClick={onCancel}>Отменить</button>}
          {(phase === 'done' || phase === 'error') && <button className="primary-button" type="button" onClick={onCancel}>Закрыть</button>}
        </footer>
      </section>
    </div>
  );
}
