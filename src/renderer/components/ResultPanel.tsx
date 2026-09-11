import { useMemo } from 'react';
import { CheckCircle2, Clipboard, Download, LoaderCircle, TriangleAlert } from 'lucide-react';
import { DataGrid, type Column, type RenderHeaderCellProps } from 'react-data-grid';
import 'react-data-grid/lib/styles.css';
import type { CellValue, ExecutionStatus, QueryColumn, QueryRow, TransactionState } from '../../shared/contracts';

export interface DocumentResult {
  columns: QueryColumn[];
  elapsedMs: number;
  error?: string;
  executionId?: string;
  hasMore: boolean;
  message: string;
  rows: QueryRow[];
  status: ExecutionStatus;
  transactionState: TransactionState;
}

interface ResultPanelProps {
  onCopy(): void;
  onExport(): void;
  onFetchMore(): void;
  result: DocumentResult;
  theme: 'light' | 'dark';
}

function displayCell(value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function Header({ column }: RenderHeaderCellProps<QueryRow>) {
  const source = column as Column<QueryRow> & { source?: QueryColumn };
  return (
    <div className="result-header-cell">
      <strong>{source.source?.name ?? column.name}</strong>
      <small>{source.source?.typeName}</small>
    </div>
  );
}

export function ResultPanel({ onCopy, onExport, onFetchMore, result, theme }: ResultPanelProps) {
  const columns = useMemo<Column<QueryRow>[]>(() => [
    {
      key: '__index',
      name: '#',
      width: 48,
      minWidth: 42,
      frozen: true,
      resizable: false,
      renderCell: ({ row }) => <span className="row-index">{row.index}</span>,
    },
    ...result.columns.map((column, index) => ({
      key: column.key,
      name: column.name,
      source: column,
      minWidth: 130,
      width: Math.max(150, Math.min(320, column.name.length * 12 + 60)),
      resizable: true,
      renderHeaderCell: Header,
      renderCell: ({ row }: { row: QueryRow }) => {
        const value = row.cells[index];
        return (
          <span className={value === null ? 'null-cell' : ''} title={displayCell(value)}>
            {displayCell(value)}
          </span>
        );
      },
    })),
  ], [result.columns]);

  const loading = ['queued', 'running', 'fetching', 'cancel-requested'].includes(result.status);

  return (
    <section className="result-panel" aria-label="Результат запроса">
      <div className="result-tabs">
        <button className="result-tab is-active" type="button">
          Результат
          {result.rows.length > 0 && <span>{result.rows.length}</span>}
        </button>
        <button className="result-tab" type="button">Сообщения</button>
        <div className="result-actions">
          <button className="icon-text-button" type="button" onClick={onCopy} disabled={!result.rows.length}>
            <Clipboard size={15} /> Копировать
          </button>
          <button className="icon-text-button" type="button" onClick={onExport} disabled={!result.rows.length}>
            <Download size={15} /> CSV
          </button>
        </div>
      </div>
      <div className="result-content">
        {result.error ? (
          <div className="result-message error-message">
            <TriangleAlert size={18} />
            <div>
              <strong>Выполнение завершилось с ошибкой</strong>
              <span>{result.error}</span>
            </div>
          </div>
        ) : loading ? (
          <div className="result-message">
            <LoaderCircle className="spin" size={20} />
            <div><strong>Выполняется</strong><span>{result.message}</span></div>
          </div>
        ) : result.columns.length > 0 ? (
          <DataGrid
            className={theme === 'dark' ? 'rdg-dark' : 'rdg-light'}
            columns={columns}
            rows={result.rows}
            rowKeyGetter={(row: QueryRow) => row.index}
            rowHeight={35}
            headerRowHeight={54}
          />
        ) : (
          <div className="result-message empty-result">
            <CheckCircle2 size={19} />
            <div>
              <strong>{result.status === 'ready' ? 'Команда выполнена' : 'Результатов пока нет'}</strong>
              <span>{result.message}</span>
            </div>
          </div>
        )}
      </div>
      <div className="result-status">
        <span className={`status-indicator ${result.status}`}>
          {loading ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}
          {result.message}
        </span>
        {result.elapsedMs > 0 && <span>{Math.round(result.elapsedMs)} мс</span>}
        {result.hasMore && (
          <button className="fetch-more" type="button" onClick={onFetchMore} disabled={loading}>
            Получить ещё
          </button>
        )}
      </div>
    </section>
  );
}
