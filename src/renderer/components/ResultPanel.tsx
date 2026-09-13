import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clipboard, Download, FileDown, FileSpreadsheet, LoaderCircle, SquarePen, TriangleAlert } from 'lucide-react';
import { DataGrid, type Column, type RenderHeaderCellProps } from 'react-data-grid';
import 'react-data-grid/lib/styles.css';
import type { CellValue, ExecutionStatus, QueryColumn, QueryRow, TransactionState } from '../../shared/contracts';
import { isLobCellValue, lobCellLabel } from '../../shared/lob';

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
  onExportExcel(): void;
  onFetchMore(): void;
  onOpenLob(rowIndex: number, columnIndex: number): void;
  onSaveLob(rowIndex: number, columnIndex: number): void;
  result: DocumentResult;
  scale: number;
  theme: 'light' | 'dark';
}

interface CellMenuState {
  columnIndex: number;
  rowIndex: number;
  x: number;
  y: number;
}

function displayCell(value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (isLobCellValue(value)) return lobCellLabel(value);
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

export function ResultPanel({ onCopy, onExport, onExportExcel, onFetchMore, onOpenLob, onSaveLob, result, scale, theme }: ResultPanelProps) {
  const [menu, setMenu] = useState<CellMenuState>();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(undefined);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(undefined);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

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
        const openMenu = (event: React.MouseEvent) => {
          event.preventDefault();
          setMenu({ rowIndex: row.index, columnIndex: index, x: event.clientX, y: event.clientY });
        };
        if (isLobCellValue(value)) {
          return (
            <span
              className={`lob-cell${value.available ? '' : ' is-unavailable'}`}
              title={value.available ? 'Двойной клик — открыть значение' : 'Значение не сохранялось из-за лимита памяти'}
              onContextMenu={openMenu}
              onDoubleClick={() => { if (value.available) onOpenLob(row.index, index); }}
            >
              {lobCellLabel(value)}
            </span>
          );
        }
        return (
          <span
            className={value === null ? 'null-cell' : ''}
            title={displayCell(value)}
            onContextMenu={openMenu}
          >
            {displayCell(value)}
          </span>
        );
      },
    })),
  ], [onOpenLob, result.columns]);

  const menuValue = (() => {
    if (!menu) return undefined;
    const row = result.rows.find((candidate) => candidate.index === menu.rowIndex);
    return row?.cells[menu.columnIndex];
  })();

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
          <button className="icon-text-button" type="button" onClick={onExportExcel} disabled={!result.rows.length || !result.executionId}>
            <FileSpreadsheet size={15} /> Excel
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
            rowHeight={Math.round(35 * scale)}
            headerRowHeight={Math.round(54 * scale)}
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
      {menu && (
        <div
          className="cell-menu"
          ref={menuRef}
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {isLobCellValue(menuValue) && menuValue.available && (
            <>
              <button type="button" role="menuitem" onClick={() => { setMenu(undefined); onOpenLob(menu.rowIndex, menu.columnIndex); }}>
                <SquarePen size={14} /> Открыть значение
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenu(undefined); onSaveLob(menu.rowIndex, menu.columnIndex); }}>
                <FileDown size={14} /> Сохранить в файл…
              </button>
            </>
          )}
          {isLobCellValue(menuValue) && !menuValue.available && (
            <span className="cell-menu-note">Значение не загружено из-за лимита памяти</span>
          )}
          {!isLobCellValue(menuValue) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(undefined);
                void navigator.clipboard.writeText(displayCell(menuValue ?? null));
              }}
            >
              <Clipboard size={14} /> Копировать
            </button>
          )}
        </div>
      )}
    </section>
  );
}
