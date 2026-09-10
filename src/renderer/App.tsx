import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BootstrapPayload,
  CellValue,
  CursorPosition,
  MetadataSnapshot,
  QueryPage,
  ThemePreference,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createPerformanceWorkspace } from '../shared/defaults';
import { DocumentTabs } from './components/DocumentTabs';
import { ExecutionToolbar } from './components/ExecutionToolbar';
import { Explorer } from './components/Explorer';
import { type DocumentResult, ResultPanel } from './components/ResultPanel';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { SqlEditor, type SqlEditorHandle } from './editor/SqlEditor';
import { disposeDocumentModel } from './editor/editor-models';
import { getApi } from './mock-api';
import {
  activeDocument,
  addDocument,
  closeDocument,
  restoreClosedDocument,
  selectDocument,
  updateDocument,
} from './state/workspace';

const emptyResult = (): DocumentResult => ({
  status: 'idle',
  columns: [],
  rows: [],
  hasMore: false,
  elapsedMs: 0,
  message: 'Выполните запрос, чтобы увидеть данные',
  transactionState: 'clean',
});

interface DiagnosticsWindow extends Window {
  __SQLX_DIAGNOSTICS__?: {
    documentCount: number;
    editorInstances: number;
    modelCount: number;
  };
}

function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

function resultFromPage(page: QueryPage, previous?: DocumentResult): DocumentResult {
  return {
    status: page.status,
    columns: page.columns,
    rows: previous && previous.executionId === page.executionId
      ? [...previous.rows, ...page.rows]
      : page.rows,
    hasMore: page.hasMore,
    elapsedMs: page.elapsedMs,
    executionId: page.executionId,
    message: page.message,
    transactionState: page.transactionState,
  };
}

function csvValue(value: CellValue): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function resultAsDelimited(result: DocumentResult, separator: '\t' | ','): string {
  const header = result.columns.map((column) => csvValue(column.name)).join(separator);
  const rows = result.rows.map((row) => row.cells.map(csvValue).join(separator));
  return [header, ...rows].join('\r\n');
}

export function App() {
  const api = useMemo(getApi, []);
  const editorRef = useRef<SqlEditorHandle>(null);
  const initializedAt = useRef(performance.now());
  const [bootstrap, setBootstrap] = useState<BootstrapPayload>();
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [metadata, setMetadata] = useState<Record<string, MetadataSnapshot>>({});
  const [results, setResults] = useState<Record<string, DocumentResult>>({});
  const [cursor, setCursor] = useState<CursorPosition>({ lineNumber: 1, column: 1 });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string>();
  const performanceMode = useMemo(
    () => new URLSearchParams(location.search).get('performance') === '1',
    [],
  );

  useEffect(() => {
    let active = true;
    void api.bootstrap().then((payload) => {
      if (!active) return;
      const parameters = new URLSearchParams(location.search);
      const documentCount = Number(parameters.get('documents'));
      const payloadKb = Number(parameters.get('payloadKb')) || 64;
      const initialWorkspace = documentCount > 0
        ? createPerformanceWorkspace(documentCount, payloadKb)
        : payload.workspace;
      setBootstrap(payload);
      setMetadata(Object.fromEntries(payload.metadata.map((snapshot) => [snapshot.connectionId, snapshot])));
      setWorkspace(initialWorkspace);
      const diagnosticsWindow = window as DiagnosticsWindow;
      diagnosticsWindow.__SQLX_DIAGNOSTICS__ = {
        documentCount: initialWorkspace.documents.length,
        editorInstances: diagnosticsWindow.__SQLX_DIAGNOSTICS__?.editorInstances ?? 0,
        modelCount: diagnosticsWindow.__SQLX_DIAGNOSTICS__?.modelCount ?? 0,
      };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        api.reportMetric({
          name: 'workspace-first-stable-frame',
          durationMs: performance.now() - initializedAt.current,
          recordedAt: new Date().toISOString(),
          detail: { documents: initialWorkspace.documents.length, payloadKb },
        });
      }));
    }).catch((error: unknown) => {
      setToast(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const resolvedTheme = resolveTheme(workspace?.theme ?? 'system', systemDark);

  useEffect(() => {
    globalThis.document.documentElement.dataset.theme = resolvedTheme;
    api.setTitleBarTheme(resolvedTheme);
  }, [api, resolvedTheme]);

  useEffect(() => {
    if (!workspace || performanceMode) return;
    const timeout = window.setTimeout(() => {
      void api.saveWorkspace(workspace).catch((error: unknown) => {
        setToast(error instanceof Error ? error.message : String(error));
      });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [api, performanceMode, workspace]);

  useEffect(() => {
    let restoreStarted = 0;
    const begin = () => { restoreStarted = performance.now(); };
    const finish = () => {
      if (!restoreStarted) return;
      const started = restoreStarted;
      restoreStarted = 0;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        api.reportMetric({
          name: 'window-visible-two-frames',
          durationMs: performance.now() - started,
          recordedAt: new Date().toISOString(),
          detail: { documents: workspace?.documents.length ?? 0 },
        });
      }));
    };
    const visibility = () => {
      if (globalThis.document.visibilityState === 'hidden') begin();
      else finish();
    };
    window.addEventListener('blur', begin);
    window.addEventListener('focus', finish);
    globalThis.document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', begin);
      window.removeEventListener('focus', finish);
      globalThis.document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, workspace?.documents.length]);

  const execute = useCallback(async () => {
    if (!workspace || !bootstrap) return;
    const document = activeDocument(workspace);
    const sql = editorRef.current?.getSqlToExecute().trim() ?? document.text.trim();
    if (!sql) {
      setToast('Нет SQL для выполнения');
      return;
    }
    const executionId = crypto.randomUUID();
    setResults((current) => ({
      ...current,
      [document.id]: {
        ...(current[document.id] ?? emptyResult()),
        status: 'running',
        error: undefined,
        executionId,
        message: 'Запрос выполняется…',
      },
    }));
    try {
      const page = await api.execute({
        connectionId: document.connectionId,
        documentId: document.id,
        executionId,
        pageSize: 300,
        sql,
      });
      setResults((current) => ({
        ...current,
        [document.id]: resultFromPage(page),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => ({
        ...current,
        [document.id]: {
          ...(current[document.id] ?? emptyResult()),
          status: /cancel|break|ORA-01013/iu.test(message) ? 'cancelled' : 'error',
          error: message,
          message: /cancel|break|ORA-01013/iu.test(message) ? 'Выполнение отменено' : 'Ошибка выполнения',
        },
      }));
    }
  }, [api, bootstrap, workspace]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !workspace || !bootstrap) return;
      if (event.key.toLocaleLowerCase() === 'n') {
        event.preventDefault();
        const connection = bootstrap.connections.find(
          (candidate) => candidate.id === workspace.explorerConnectionId,
        ) ?? bootstrap.connections[0];
        setWorkspace(addDocument(workspace, connection));
      } else if (event.key.toLocaleLowerCase() === 'w') {
        event.preventDefault();
        const connection = bootstrap.connections.find(
          (candidate) => candidate.id === workspace.explorerConnectionId,
        ) ?? bootstrap.connections[0];
        const documentId = workspace.activeDocumentId;
        disposeDocumentModel(documentId);
        setWorkspace(closeDocument(workspace, documentId, connection));
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === 't') {
        event.preventDefault();
        setWorkspace(restoreClosedDocument(workspace));
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [bootstrap, workspace]);

  if (!workspace || !bootstrap) {
    return (
      <div className="splash-screen">
        <div className="app-mark large">›_</div>
        <strong>SQLExplorer</strong>
        <span>{toast ?? 'Подготовка рабочей области…'}</span>
      </div>
    );
  }

  const document = activeDocument(workspace);
  const connection = bootstrap.connections.find((candidate) => candidate.id === document.connectionId)
    ?? bootstrap.connections[0];
  const explorerConnection = bootstrap.connections.find(
    (candidate) => candidate.id === workspace.explorerConnectionId,
  ) ?? bootstrap.connections[0];
  const explorerMetadata = metadata[workspace.explorerConnectionId];
  const documentMetadata = metadata[document.connectionId];
  const result = results[document.id] ?? emptyResult();

  const updateResult = (documentId: string, updater: (current: DocumentResult) => DocumentResult) => {
    setResults((current) => ({
      ...current,
      [documentId]: updater(current[documentId] ?? emptyResult()),
    }));
  };

  const cancel = async () => {
    if (!result.executionId) return;
    updateResult(document.id, (current) => ({
      ...current,
      status: 'cancel-requested',
      message: 'Отправлен запрос на отмену…',
    }));
    try {
      await api.cancel(result.executionId);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const fetchMore = async () => {
    if (!result.executionId || !result.hasMore) return;
    updateResult(document.id, (current) => ({ ...current, status: 'fetching', message: 'Получение строк…' }));
    try {
      const page = await api.fetchMore({ executionId: result.executionId, pageSize: 300 });
      setResults((current) => ({
        ...current,
        [document.id]: resultFromPage(page, current[document.id]),
      }));
    } catch (error) {
      updateResult(document.id, (current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        message: 'Не удалось получить следующую порцию',
      }));
    }
  };

  const transact = async (action: 'commit' | 'rollback') => {
    try {
      await api[action]({ connectionId: document.connectionId, documentId: document.id });
      updateResult(document.id, (current) => ({
        ...current,
        transactionState: 'clean',
        message: action === 'commit' ? 'Изменения зафиксированы' : 'Изменения отменены',
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshMetadata = async () => {
    setRefreshing(true);
    try {
      const snapshot = await api.refreshMetadata(workspace.explorerConnectionId);
      setMetadata((current) => ({ ...current, [snapshot.connectionId]: snapshot }));
      setToast(`Метаданные ${snapshot.schema}: ${snapshot.objects.length} объектов`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const add = () => setWorkspace(addDocument(workspace, explorerConnection));
  const close = (documentId: string) => {
    disposeDocumentModel(documentId);
    setWorkspace(closeDocument(workspace, documentId, explorerConnection));
  };
  const changeText = (documentId: string, text: string) => {
    const current = workspace.documents.find((candidate) => candidate.id === documentId);
    if (current?.text === text) return;
    setWorkspace((value) => value ? updateDocument(value, documentId, { text, dirty: true }) : value);
  };
  const changeConnection = (connectionId: string) => {
    if (result.transactionState === 'changed') {
      setToast('Сначала выполните Commit или Rollback для текущего документа');
      return;
    }
    const selected = bootstrap.connections.find((candidate) => candidate.id === connectionId);
    if (!selected) return;
    setWorkspace(updateDocument(workspace, document.id, {
      connectionId: selected.id,
      dialect: selected.kind,
    }));
  };

  const copy = () => {
    void navigator.clipboard.writeText(resultAsDelimited(result, '\t')).then(
      () => setToast(`Скопировано строк: ${result.rows.length}`),
      (error: unknown) => setToast(error instanceof Error ? error.message : String(error)),
    );
  };
  const exportCsv = () => {
    const blob = new Blob([`\uFEFF${resultAsDelimited(result, ',')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${document.title.replace(/\.sql$/iu, '')}-result.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setToast(`CSV подготовлен: ${result.rows.length} строк`);
  };

  const resizeResult = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = workspace.resultPanelHeight;
    const move = (moveEvent: PointerEvent) => {
      const height = Math.max(150, Math.min(window.innerHeight - 280, startHeight + startY - moveEvent.clientY));
      setWorkspace((current) => current ? { ...current, resultPanelHeight: height } : current);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  return (
    <div className="app-shell" data-theme={resolvedTheme} data-performance={performanceMode || undefined}>
      <TitleBar
        explorerVisible={workspace.explorerVisible}
        onToggleExplorer={() => setWorkspace({ ...workspace, explorerVisible: !workspace.explorerVisible })}
        onToggleTheme={() => setWorkspace({ ...workspace, theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}
        theme={resolvedTheme}
      />
      <div className={`workbench ${workspace.explorerVisible ? '' : 'explorer-hidden'}`}>
        {workspace.explorerVisible && (
          <Explorer
            connections={bootstrap.connections}
            metadata={explorerMetadata}
            onRefresh={() => { void refreshMetadata(); }}
            onSelectConnection={(connectionId) => setWorkspace({ ...workspace, explorerConnectionId: connectionId })}
            refreshing={refreshing}
            selectedConnectionId={workspace.explorerConnectionId}
          />
        )}
        <main
          className="document-workspace"
          style={{ '--result-height': `${workspace.resultPanelHeight}px` } as React.CSSProperties}
        >
          <DocumentTabs
            activeDocumentId={workspace.activeDocumentId}
            canRestore={workspace.closedDocuments.length > 0}
            documents={workspace.documents}
            onAdd={add}
            onClose={close}
            onRestore={() => setWorkspace(restoreClosedDocument(workspace))}
            onSelect={(documentId) => setWorkspace(selectDocument(workspace, documentId))}
          />
          <ExecutionToolbar
            connection={connection}
            connections={bootstrap.connections}
            status={result.status}
            transactionChanged={result.transactionState === 'changed'}
            onCancel={() => { void cancel(); }}
            onChangeConnection={changeConnection}
            onCommit={() => { void transact('commit'); }}
            onExecute={() => { void execute(); }}
            onRollback={() => { void transact('rollback'); }}
            onSuggestions={() => editorRef.current?.showSuggestions()}
          />
          <div className="editor-region">
            <div className="editor-breadcrumb">
              <span>{documentMetadata?.schema ?? connection.username}</span>
              <span>›</span>
              <strong>{document.title}</strong>
              {performanceMode && <b className="performance-badge">PERF · {workspace.documents.length}</b>}
            </div>
            <SqlEditor
              ref={editorRef}
              document={document}
              metadata={documentMetadata}
              onChange={changeText}
              onCursorChange={setCursor}
              onExecute={() => { void execute(); }}
              theme={resolvedTheme}
            />
            <div className="editor-footnote">
              {document.dialect === 'oracle' ? 'Oracle SQL' : 'PostgreSQL'} · UTF-8
            </div>
          </div>
          <div className="result-resizer" onPointerDown={resizeResult} role="separator" aria-orientation="horizontal" />
          <ResultPanel
            onCopy={copy}
            onExport={exportCsv}
            onFetchMore={() => { void fetchMore(); }}
            result={result}
            theme={resolvedTheme}
          />
        </main>
      </div>
      <StatusBar
        connection={connection}
        cursor={cursor}
        documentCount={workspace.documents.length}
        transactionChanged={result.transactionState === 'changed'}
      />
      {toast && (
        <button className="toast" type="button" onClick={() => setToast(undefined)}>{toast}</button>
      )}
    </div>
  );
}
