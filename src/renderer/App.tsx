import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BootstrapPayload,
  CellValue,
  ConnectionMenuAction,
  ConnectionProfileInput,
  CursorPosition,
  FileCommand,
  MetadataSnapshot,
  OpenedSqlFile,
  PublicConnectionProfile,
  QueryPage,
  RecentSqlFile,
  SessionState,
  SqlDocument,
  TextFileBom,
  TextFileEol,
  ThemePreference,
  WorkspaceSnapshot,
} from '../shared/contracts';
import { createPerformanceWorkspace } from '../shared/defaults';
import { ConnectionDialog } from './components/ConnectionDialog';
import { AppCloseDialog } from './components/AppCloseDialog';
import {
  CloseDocumentDialog,
  FileComparisonDialog,
  FileConflictDialog,
  SessionResetDialog,
} from './components/DecisionDialogs';
import { DocumentTabs } from './components/DocumentTabs';
import { EncodingDialog } from './components/EncodingDialog';
import { ExecutionToolbar } from './components/ExecutionToolbar';
import { Explorer } from './components/Explorer';
import { OracleSettingsDialog } from './components/OracleSettingsDialog';
import { type DocumentResult, ResultPanel } from './components/ResultPanel';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { SqlEditor, type SqlEditorHandle } from './editor/SqlEditor';
import { disposeDocumentModel } from './editor/editor-models';
import { getApi } from './mock-api';
import {
  activeDocument,
  addDocument,
  addOpenedDocument,
  closeDocument,
  restoreClosedDocument,
  selectDocument,
  updateDocument,
} from './state/workspace';

const emptyResult = (): DocumentResult => ({
  status: 'idle', columns: [], rows: [], hasMore: false, elapsedMs: 0,
  message: 'Выполните запрос, чтобы увидеть данные', transactionState: 'clean',
});

interface DiagnosticsWindow extends Window {
  __SQLX_DIAGNOSTICS__?: {
    documentCount: number;
    editorInstances: number;
    modelCount: number;
  };
}

interface ConnectionDialogState {
  profileId?: string;
}

interface FileConflictState {
  documentId: string;
}

function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

function resultFromPage(page: QueryPage, previous?: DocumentResult): DocumentResult {
  return {
    status: page.status,
    columns: page.columns,
    rows: previous && previous.executionId === page.executionId ? [...previous.rows, ...page.rows] : page.rows,
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

function openedFields(file: OpenedSqlFile) {
  return {
    filePath: file.filePath,
    title: file.title,
    text: file.text,
    encoding: file.encoding,
    bom: file.bom,
    eol: file.eol,
    diskVersion: file.diskVersion,
  };
}

export function App() {
  const api = useMemo(getApi, []);
  const editorRef = useRef<SqlEditorHandle>(null);
  const initializedAt = useRef(performance.now());
  const fileCommandRef = useRef<(command: FileCommand) => void>(() => undefined);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload>();
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [metadata, setMetadata] = useState<Record<string, MetadataSnapshot>>({});
  const [results, setResults] = useState<Record<string, DocumentResult>>({});
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const [cursor, setCursor] = useState<CursorPosition>({ lineNumber: 1, column: 1 });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string>();
  const [connectionDialog, setConnectionDialog] = useState<ConnectionDialogState>();
  const [oracleSettingsOpen, setOracleSettingsOpen] = useState(false);
  const [pendingCloseId, setPendingCloseId] = useState<string>();
  const [fileConflict, setFileConflict] = useState<FileConflictState>();
  const [encodingDocumentId, setEncodingDocumentId] = useState<string>();
  const [recentFiles, setRecentFiles] = useState<RecentSqlFile[]>([]);
  const [appClosePhase, setAppClosePhase] = useState<'transactions' | 'files'>();
  const [pendingSessionAction, setPendingSessionAction] = useState<'disconnect' | 'reconnect'>();
  const [fileComparison, setFileComparison] = useState<{ diskText: string; documentId: string }>();
  const performanceMode = useMemo(() => new URLSearchParams(location.search).get('performance') === '1', []);

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
      setSessionStates(Object.fromEntries(payload.sessionStates.map((state) => [state.documentId, state])));
      setWorkspace(initialWorkspace);
      const diagnosticsWindow = window as DiagnosticsWindow;
      diagnosticsWindow.__SQLX_DIAGNOSTICS__ = {
        documentCount: initialWorkspace.documents.length,
        editorInstances: diagnosticsWindow.__SQLX_DIAGNOSTICS__?.editorInstances ?? 0,
        modelCount: diagnosticsWindow.__SQLX_DIAGNOSTICS__?.modelCount ?? 0,
      };
      requestAnimationFrame(() => requestAnimationFrame(() => api.reportMetric({
        name: 'workspace-first-stable-frame',
        durationMs: performance.now() - initializedAt.current,
        recordedAt: new Date().toISOString(),
        detail: { documents: initialWorkspace.documents.length, payloadKb },
      })));
    }).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)));
    return () => { active = false; };
  }, [api]);

  useEffect(() => api.onSessionStateChanged((state) => {
    setSessionStates((current) => ({ ...current, [state.documentId]: state }));
    setResults((current) => {
      const result = current[state.documentId];
      if (!result) return current;
      return { ...current, [state.documentId]: { ...result, transactionState: state.transactionState } };
    });
  }), [api]);

  useEffect(() => api.onFileCommand((command) => fileCommandRef.current(command)), [api]);

  useEffect(() => api.onBeforeAppClose(() => {
    if (!workspace) {
      void api.confirmAppClose(true);
      return;
    }
    const transactionCount = workspace.documents.filter((document) =>
      sessionStates[document.id]?.transactionState === 'changed'
      || results[document.id]?.transactionState === 'changed').length;
    if (transactionCount) setAppClosePhase('transactions');
    else if (workspace.documents.some((document) => document.dirty)) setAppClosePhase('files');
    else void api.confirmAppClose(true);
  }), [api, results, sessionStates, workspace]);

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
      void api.saveWorkspace(workspace).catch((error: unknown) =>
        setToast(error instanceof Error ? error.message : String(error)));
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
      requestAnimationFrame(() => requestAnimationFrame(() => api.reportMetric({
        name: 'window-visible-two-frames', durationMs: performance.now() - started,
        recordedAt: new Date().toISOString(), detail: { documents: workspace?.documents.length ?? 0 },
      })));
    };
    const visibility = () => globalThis.document.visibilityState === 'hidden' ? begin() : finish();
    window.addEventListener('blur', begin);
    window.addEventListener('focus', finish);
    globalThis.document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', begin);
      window.removeEventListener('focus', finish);
      globalThis.document.removeEventListener('visibilitychange', visibility);
    };
  }, [api, workspace?.documents.length]);

  const connections = bootstrap?.connections ?? [];
  const currentDocument = workspace ? activeDocument(workspace) : undefined;
  const connection = currentDocument?.connectionId
    ? connections.find((candidate) => candidate.id === currentDocument.connectionId)
    : undefined;
  const session = currentDocument ? sessionStates[currentDocument.id] : undefined;
  const result = currentDocument ? results[currentDocument.id] ?? emptyResult() : emptyResult();

  const connectionForContext = (snapshot: WorkspaceSnapshot): PublicConnectionProfile | undefined => {
    const selected = snapshot.explorerVisible && snapshot.explorerConnectionId
      ? connections.find((candidate) => candidate.id === snapshot.explorerConnectionId)
      : undefined;
    const active = activeDocument(snapshot);
    return selected ?? (active.connectionId ? connections.find((candidate) => candidate.id === active.connectionId) : undefined);
  };

  const connectionForActiveDocument = (snapshot: WorkspaceSnapshot): PublicConnectionProfile | undefined => {
    const active = activeDocument(snapshot);
    return active.connectionId
      ? connections.find((candidate) => candidate.id === active.connectionId)
      : undefined;
  };

  const addForConnection = (connectionId: string | null) => {
    if (!workspace) return;
    const selected = connectionId ? connections.find((candidate) => candidate.id === connectionId) : undefined;
    setWorkspace(addDocument(workspace, selected, { dirty: false }));
  };

  const add = () => {
    if (!workspace) return;
    const selected = connectionForContext(workspace);
    setWorkspace(addDocument(workspace, selected, { dirty: false }));
  };

  const openFiles = async (paths?: string[]) => {
    if (!workspace) return;
    try {
      const files = await api.openSqlFiles(paths ? { paths } : undefined);
      if (!files.length) return;
      const selected = connectionForActiveDocument(workspace);
      let next = workspace;
      for (const file of files) next = addOpenedDocument(next, selected, openedFields(file), bootstrap?.platform === 'win32');
      setWorkspace(next);
      const uncertain = files.find((file) => file.uncertainEncoding);
      if (uncertain) {
        const opened = next.documents.find((document) => document.filePath === uncertain.filePath);
        if (opened) setEncodingDocumentId(opened.id);
      }
      setToast(`Открыто файлов: ${files.length}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const openDroppedFiles = async (files: File[]) => {
    if (!workspace || !files.length) return;
    try {
      const opened = await api.openDroppedFiles(files);
      const selected = connectionForActiveDocument(workspace);
      let next = workspace;
      for (const file of opened) next = addOpenedDocument(next, selected, openedFields(file), bootstrap?.platform === 'win32');
      setWorkspace(next);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const saveDocument = async (documentId: string, saveAs = false, force = false): Promise<boolean> => {
    if (!workspace) return false;
    const document = workspace.documents.find((candidate) => candidate.id === documentId);
    if (!document) return false;
    try {
      const saved = await api.saveSqlFile({
        title: document.title,
        text: document.text,
        filePath: document.filePath,
        diskVersion: document.diskVersion,
        encoding: document.encoding,
        bom: document.bom,
        eol: document.eol,
        saveAs,
        force,
      });
      if (saved.status === 'cancelled') return false;
      if (saved.status === 'conflict') {
        setFileConflict({ documentId });
        return false;
      }
      setWorkspace((current) => current ? updateDocument(current, documentId, {
        ...openedFields(saved.file), dirty: false,
      }) : current);
      setToast(`Сохранено: ${saved.file.title}`);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const finishClose = async (documentId: string, rememberClosed = true) => {
    if (!workspace) return;
    const document = workspace.documents.find((candidate) => candidate.id === documentId);
    const profile = document?.connectionId
      ? connections.find((candidate) => candidate.id === document.connectionId)
      : undefined;
    if (document && profile && sessionStates[documentId]?.status !== 'disconnected') {
      try {
        await api.disconnect({ connectionId: profile.id, documentId, force: true });
      } catch {
        // Closing a document is still allowed if its physical connection has already vanished.
      }
    }
    disposeDocumentModel(documentId);
    setWorkspace((current) => current
      ? closeDocument(current, documentId, connectionForContext(current), rememberClosed)
      : current);
    setPendingCloseId(undefined);
  };

  const discardAndClose = async (document: SqlDocument) => {
    if (document.filePath) {
      try {
        const disk = await api.reopenSqlFile({ filePath: document.filePath, encoding: document.encoding });
        setWorkspace((current) => current ? updateDocument(current, document.id, {
          ...openedFields(disk), dirty: false,
        }) : current);
        await finishClose(document.id, true);
        return;
      } catch {
        // If the backing file disappeared, discarding means removing the unsaved document.
      }
    }
    await finishClose(document.id, false);
  };

  const execute = useCallback(async () => {
    if (!workspace || !bootstrap) return;
    const document = activeDocument(workspace);
    if (!document.connectionId) {
      setToast('Выберите соединение для этой вкладки');
      return;
    }
    const sql = editorRef.current?.getSqlToExecute().trim() ?? document.text.trim();
    if (!sql) {
      setToast('Нет SQL для выполнения');
      return;
    }
    const executionId = crypto.randomUUID();
    setResults((current) => ({
      ...current,
      [document.id]: {
        ...(current[document.id] ?? emptyResult()), status: 'running', error: undefined,
        executionId, message: 'Запрос выполняется…',
      },
    }));
    try {
      const page = await api.execute({
        connectionId: document.connectionId, documentId: document.id,
        executionId, pageSize: 300, sql,
      });
      setResults((current) => ({ ...current, [document.id]: resultFromPage(page) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error && typeof error === 'object' && 'kind' in error ? String(error.kind) : 'unknown';
      const cancelled = kind === 'cancelled';
      setResults((current) => ({
        ...current,
        [document.id]: {
          ...(current[document.id] ?? emptyResult()),
          status: cancelled ? 'cancelled' : 'error',
          error: message,
          message: cancelled ? 'Выполнение отменено' : kind === 'connection' ? 'Соединение потеряно' : 'Ошибка выполнения',
        },
      }));
    }
  }, [api, bootstrap, workspace]);

  const cancel = async () => {
    if (!currentDocument || !result.executionId) return;
    setResults((current) => ({
      ...current,
      [currentDocument.id]: { ...(current[currentDocument.id] ?? emptyResult()), status: 'cancel-requested', message: 'Отправлен запрос на отмену…' },
    }));
    try { await api.cancel(result.executionId); }
    catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  };

  const fetchMore = async () => {
    if (!currentDocument || !result.executionId || !result.hasMore) return;
    const documentId = currentDocument.id;
    setResults((current) => ({ ...current, [documentId]: { ...(current[documentId] ?? emptyResult()), status: 'fetching', message: 'Получение строк…' } }));
    try {
      const page = await api.fetchMore({ executionId: result.executionId, pageSize: 300 });
      setResults((current) => ({ ...current, [documentId]: resultFromPage(page, current[documentId]) }));
    } catch (error) {
      setResults((current) => ({ ...current, [documentId]: { ...(current[documentId] ?? emptyResult()), status: 'error', error: error instanceof Error ? error.message : String(error), message: 'Не удалось получить следующую порцию' } }));
    }
  };

  const transact = async (action: 'commit' | 'rollback', document = currentDocument): Promise<boolean> => {
    if (!document?.connectionId) return false;
    try {
      await api[action]({ connectionId: document.connectionId, documentId: document.id });
      setResults((current) => ({ ...current, [document.id]: { ...(current[document.id] ?? emptyResult()), transactionState: 'clean', message: action === 'commit' ? 'Изменения зафиксированы' : 'Изменения отменены' } }));
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const connect = async (mode: 'connect' | 'reconnect' | 'disconnect') => {
    if (!currentDocument?.connectionId) return;
    try {
      await api[mode]({ connectionId: currentDocument.connectionId, documentId: currentDocument.id });
    } catch (error) {
      if ((mode === 'disconnect' || mode === 'reconnect')
        && error && typeof error === 'object' && 'kind' in error && error.kind === 'transaction') {
        setPendingSessionAction(mode);
        return;
      }
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const changeConnection = async (connectionId: string | null) => {
    if (!workspace || !currentDocument) return;
    const transactionChanged = session?.transactionState === 'changed' || result.transactionState === 'changed';
    if (transactionChanged) {
      setToast('Сначала выполните Commit или Rollback для текущей вкладки');
      return;
    }
    if (currentDocument.connectionId && session && session.status !== 'disconnected') {
      try { await api.disconnect({ connectionId: currentDocument.connectionId, documentId: currentDocument.id }); }
      catch (error) { setToast(error instanceof Error ? error.message : String(error)); return; }
    }
    const selected = connectionId ? connections.find((candidate) => candidate.id === connectionId) : undefined;
    setWorkspace(updateDocument(workspace, currentDocument.id, {
      connectionId: selected?.id ?? null,
      dialect: selected?.kind ?? 'sql',
    }));
    setSessionStates((current) => {
      const next = { ...current };
      delete next[currentDocument.id];
      return next;
    });
  };

  const refreshMetadata = async () => {
    if (!workspace?.explorerConnectionId) {
      setToast('Выберите соединение');
      return;
    }
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

  const saveProfile = async (input: ConnectionProfileInput) => {
    const profile = await api.saveConnection(input);
    setBootstrap((current) => current ? {
      ...current,
      connections: current.connections.some((value) => value.id === profile.id)
        ? current.connections.map((value) => value.id === profile.id ? profile : value)
        : [...current.connections, profile].sort((left, right) => left.name.localeCompare(right.name)),
    } : current);
    setWorkspace((current) => current ? {
      ...current,
      explorerConnectionId: current.explorerConnectionId ?? profile.id,
    } : current);
    setConnectionDialog(undefined);
    setToast(`Соединение сохранено: ${profile.name}`);
  };

  const reloadConnectionConfiguration = async () => {
    const fresh = await api.bootstrap();
    setBootstrap((current) => current ? {
      ...current,
      connections: fresh.connections,
      oracleClients: fresh.oracleClients,
      oracleSettings: fresh.oracleSettings,
    } : current);
  };

  const deleteProfile = async (connectionId: string) => {
    const profile = connections.find((candidate) => candidate.id === connectionId);
    if (Object.values(sessionStates).some((state) =>
      state.connectionId === connectionId && state.transactionState === 'changed')) {
      setToast('Нельзя удалить соединение с незавершённой транзакцией');
      return;
    }
    if (!profile || !window.confirm(`Удалить соединение «${profile.name}»? SQL-документы останутся открыты без соединения.`)) return;
    try {
      await api.deleteConnection(connectionId);
      const remaining = connections.filter((candidate) => candidate.id !== connectionId);
      setBootstrap((current) => current ? { ...current, connections: remaining } : current);
      setWorkspace((current) => current ? {
        ...current,
        explorerConnectionId: current.explorerConnectionId === connectionId ? remaining[0]?.id ?? null : current.explorerConnectionId,
        documents: current.documents.map((document) => document.connectionId === connectionId
          ? { ...document, connectionId: null, dialect: 'sql' }
          : document),
      } : current);
      setMetadata((current) => {
        const next = { ...current };
        delete next[connectionId];
        return next;
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const performConnectionAction = async (connectionId: string, action: ConnectionMenuAction) => {
    const profile = connections.find((candidate) => candidate.id === connectionId);
    if (!profile) return;
    if (action === 'newDocument') addForConnection(connectionId);
    else if (action === 'edit') setConnectionDialog({ profileId: connectionId });
    else if (action === 'delete') await deleteProfile(connectionId);
    else if (action === 'test') {
      try {
        const tested = await api.testConnection({ connectionId });
        setToast(`${tested.serverVersion} · ${Math.round(tested.elapsedMs)} мс`);
      } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
    } else {
      const states = Object.values(sessionStates).filter((state) => state.connectionId === connectionId);
      if (states.some((state) => state.transactionState === 'changed')) {
        setToast('Сначала выполните Commit или Rollback во всех изменённых вкладках этого соединения');
        return;
      }
      await Promise.all(states.map((state) => api[action]({
        connectionId,
        documentId: state.documentId,
      }).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error)))));
    }
  };

  const handleConnectionMenu = async (connectionId: string) => {
    const action = await api.showConnectionMenu(connectionId);
    if (action) await performConnectionAction(connectionId, action);
  };

  const showNewDocumentMenu = async () => {
    if (bootstrap?.platform === 'browser') return;
    const choice = await api.showNewDocumentMenu();
    if (!choice) return;
    if (choice.action === 'addConnection') setConnectionDialog({});
    else addForConnection(choice.connectionId);
  };

  const saveAll = async (): Promise<boolean> => {
    if (!workspace) return true;
    for (const document of workspace.documents.filter((candidate) => candidate.dirty)) {
      if (!await saveDocument(document.id)) return false;
    }
    return true;
  };

  const resolveAppTransactions = async (action: 'commit' | 'rollback') => {
    const changedDocuments = workspace?.documents.filter((document) =>
      sessionStates[document.id]?.transactionState === 'changed'
      || results[document.id]?.transactionState === 'changed') ?? [];
    for (const document of changedDocuments) {
      if (!await transact(action, document)) return;
    }
    if (workspace?.documents.some((document) => document.dirty)) setAppClosePhase('files');
    else void api.confirmAppClose(true);
  };

  const discardAllAndClose = async () => {
    if (!workspace) return;
    let cleaned = workspace;
    for (const document of workspace.documents.filter((candidate) => candidate.dirty)) {
      if (document.filePath) {
        try {
          const disk = await api.reopenSqlFile({ filePath: document.filePath, encoding: document.encoding });
          cleaned = updateDocument(cleaned, document.id, { ...openedFields(disk), dirty: false });
          continue;
        } catch {
          // Missing or unreadable backing files are removed when the user explicitly discards changes.
        }
      }
      cleaned = closeDocument(cleaned, document.id, connectionForContext(cleaned), false);
    }
    setWorkspace(cleaned);
    await api.saveWorkspace(cleaned);
    await api.confirmAppClose(true);
  };

  fileCommandRef.current = (command) => {
    if (command === 'new') add();
    else if (command === 'open') void openFiles();
    else if (command === 'save' && currentDocument) void saveDocument(currentDocument.id);
    else if (command === 'saveAs' && currentDocument) void saveDocument(currentDocument.id, true);
    else if (command === 'saveAll') void saveAll();
    else if (command === 'close' && currentDocument) setPendingCloseId(currentDocument.id);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'n') { event.preventDefault(); fileCommandRef.current('new'); }
      else if (key === 'o') { event.preventDefault(); fileCommandRef.current('open'); }
      else if (key === 's') { event.preventDefault(); fileCommandRef.current(event.shiftKey ? 'saveAs' : 'save'); }
      else if (key === 'w') { event.preventDefault(); fileCommandRef.current('close'); }
      else if (event.shiftKey && key === 't' && workspace) {
        event.preventDefault();
        setWorkspace(restoreClosedDocument(workspace));
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [workspace]);

  if (!workspace || !bootstrap || !currentDocument) {
    return <div className="splash-screen"><div className="app-mark large">›_</div><strong>SQLExplorer</strong><span>{toast ?? 'Подготовка рабочей области…'}</span></div>;
  }

  const explorerMetadata = workspace.explorerConnectionId ? metadata[workspace.explorerConnectionId] : undefined;
  const documentMetadata = currentDocument.connectionId ? metadata[currentDocument.connectionId] : undefined;
  const closeTarget = pendingCloseId ? workspace.documents.find((document) => document.id === pendingCloseId) : undefined;
  const closeTransactionChanged = closeTarget
    ? sessionStates[closeTarget.id]?.transactionState === 'changed'
      || results[closeTarget.id]?.transactionState === 'changed'
    : false;
  const encodingTarget = encodingDocumentId
    ? workspace.documents.find((document) => document.id === encodingDocumentId)
    : undefined;
  const conflictTarget = fileConflict
    ? workspace.documents.find((document) => document.id === fileConflict.documentId)
    : undefined;
  const editProfile = connectionDialog?.profileId
    ? connections.find((candidate) => candidate.id === connectionDialog.profileId)
    : undefined;
  const appTransactionCount = workspace.documents.filter((document) =>
    sessionStates[document.id]?.transactionState === 'changed'
    || results[document.id]?.transactionState === 'changed').length;
  const appDirtyCount = workspace.documents.filter((document) => document.dirty).length;

  const applyEncoding = async (encoding: string, bom: TextFileBom, reopen: boolean) => {
    if (!encodingTarget) return;
    if (reopen && encodingTarget.filePath) {
      try {
        const opened = await api.reopenSqlFile({ filePath: encodingTarget.filePath, encoding });
        setWorkspace((current) => current ? updateDocument(current, encodingTarget.id, {
          ...openedFields(opened), dirty: false,
        }) : current);
      } catch (error) { setToast(error instanceof Error ? error.message : String(error)); return; }
    } else {
      setWorkspace((current) => current ? updateDocument(current, encodingTarget.id, {
        encoding, bom, dirty: true,
      }) : current);
    }
    setEncodingDocumentId(undefined);
  };

  const copy = () => void navigator.clipboard.writeText(resultAsDelimited(result, '\t')).then(
    () => setToast(`Скопировано строк: ${result.rows.length}`),
    (error: unknown) => setToast(error instanceof Error ? error.message : String(error)),
  );
  const exportCsv = () => {
    const blob = new Blob([`\uFEFF${resultAsDelimited(result, ',')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${currentDocument.title.replace(/\.sql$/iu, '')}-result.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
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
    <div className="app-shell" data-theme={resolvedTheme} data-performance={performanceMode || undefined} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); void openDroppedFiles([...event.dataTransfer.files]); }}>
      <TitleBar
        explorerVisible={workspace.explorerVisible}
        onFileCommand={(command) => fileCommandRef.current(command)}
        onOpenRecent={(filePath) => { void openFiles([filePath]); }}
        onRequestRecent={() => { void api.getRecentSqlFiles().then(setRecentFiles).catch(() => setRecentFiles([])); }}
        onToggleExplorer={() => setWorkspace({ ...workspace, explorerVisible: !workspace.explorerVisible })}
        onToggleTheme={() => setWorkspace({ ...workspace, theme: resolvedTheme === 'dark' ? 'light' : 'dark' })}
        recentFiles={recentFiles}
        theme={resolvedTheme}
      />
      <div className={`workbench ${workspace.explorerVisible ? '' : 'explorer-hidden'}`}>
        {workspace.explorerVisible && <Explorer
          connections={connections}
          metadata={explorerMetadata}
          nativeMenus={bootstrap.platform !== 'browser'}
          onAddConnection={() => setConnectionDialog({})}
          onConnectionAction={(connectionId, action) => { void performConnectionAction(connectionId, action); }}
          onConnectionMenu={(connectionId) => { void handleConnectionMenu(connectionId); }}
          onEditConnection={(connectionId) => setConnectionDialog({ profileId: connectionId })}
          onOpenSettings={() => setOracleSettingsOpen(true)}
          onRefresh={() => { void refreshMetadata(); }}
          onSelectConnection={(connectionId) => setWorkspace({ ...workspace, explorerConnectionId: connectionId })}
          refreshing={refreshing}
          selectedConnectionId={workspace.explorerConnectionId}
          sessionStates={Object.values(sessionStates)}
        />}
        <main className="document-workspace" style={{ '--result-height': `${workspace.resultPanelHeight}px` } as React.CSSProperties}>
          <DocumentTabs
            activeDocumentId={workspace.activeDocumentId}
            canRestore={workspace.closedDocuments.length > 0}
            connections={connections}
            documents={workspace.documents}
            nativeMenus={bootstrap.platform !== 'browser'}
            onAdd={add}
            onAddConnection={() => setConnectionDialog({})}
            onAddForConnection={addForConnection}
            onClose={setPendingCloseId}
            onOpen={() => { void openFiles(); }}
            onRestore={() => setWorkspace(restoreClosedDocument(workspace))}
            onSave={() => { void saveDocument(currentDocument.id); }}
            onSaveDocument={(documentId, saveAs) => { void saveDocument(documentId, saveAs); }}
            onSelect={(documentId) => setWorkspace(selectDocument(workspace, documentId))}
            onShowAddMenu={() => { void showNewDocumentMenu(); }}
          />
          <ExecutionToolbar
            connection={connection}
            connections={connections}
            status={result.status}
            transactionChanged={session?.transactionState === 'changed' || result.transactionState === 'changed'}
            session={session}
            onCancel={() => { void cancel(); }}
            onChangeConnection={(id) => { void changeConnection(id); }}
            onCommit={() => { void transact('commit'); }}
            onConnect={() => { void connect('connect'); }}
            onDisconnect={() => { void connect('disconnect'); }}
            onExecute={() => { void execute(); }}
            onReconnect={() => { void connect('reconnect'); }}
            onRollback={() => { void transact('rollback'); }}
            onSuggestions={() => editorRef.current?.showSuggestions()}
          />
          <div className="editor-region">
            <div className="editor-breadcrumb"><span>{documentMetadata?.schema ?? connection?.username ?? 'SQL'}</span><span>›</span><strong>{currentDocument.title}</strong>{currentDocument.filePath && <small title={currentDocument.filePath}>{currentDocument.filePath}</small>}{performanceMode && <b className="performance-badge">PERF · {workspace.documents.length}</b>}</div>
            <SqlEditor ref={editorRef} document={currentDocument} metadata={documentMetadata} onChange={(documentId, text) => {
              const current = workspace.documents.find((candidate) => candidate.id === documentId);
              if (current?.text === text) return;
              setWorkspace((value) => value ? updateDocument(value, documentId, { text, dirty: true }) : value);
            }} onCursorChange={setCursor} onExecute={() => { void execute(); }} theme={resolvedTheme} />
            <div className="editor-footnote">{currentDocument.dialect === 'oracle' ? 'Oracle SQL' : currentDocument.dialect === 'postgres' ? 'PostgreSQL' : 'SQL'} · {currentDocument.encoding.toUpperCase()} · {currentDocument.eol.toUpperCase()}</div>
          </div>
          <div className="result-resizer" onPointerDown={resizeResult} role="separator" aria-orientation="horizontal" />
          <ResultPanel onCopy={copy} onExport={exportCsv} onFetchMore={() => { void fetchMore(); }} result={result} theme={resolvedTheme} />
        </main>
      </div>
      <StatusBar connection={connection} cursor={cursor} document={currentDocument} documentCount={workspace.documents.length} onChangeEol={(eol: TextFileEol) => { if (eol !== currentDocument.eol) setWorkspace(updateDocument(workspace, currentDocument.id, { eol, dirty: true })); }} onOpenEncoding={() => setEncodingDocumentId(currentDocument.id)} session={session} transactionChanged={session?.transactionState === 'changed' || result.transactionState === 'changed'} />

      {connectionDialog && <ConnectionDialog key={connectionDialog.profileId ?? 'new'} profile={editProfile} oracleClients={bootstrap.oracleClients} oracleSettings={bootstrap.oracleSettings} onChooseDirectory={api.chooseDirectory} onClose={() => setConnectionDialog(undefined)} onListTnsAliases={api.listTnsAliases} onOpenOracleSettings={() => setOracleSettingsOpen(true)} onSave={saveProfile} onTest={(input) => api.testConnection({ profile: input })} />}
      {oracleSettingsOpen && <OracleSettingsDialog clients={bootstrap.oracleClients} settings={bootstrap.oracleSettings} onChooseDirectory={api.chooseDirectory} onClose={() => setOracleSettingsOpen(false)} onSaveSettings={async (settings) => { await api.saveOracleSettings(settings); await reloadConnectionConfiguration(); }} onSaveClient={async (input) => { await api.saveOracleClient(input); await reloadConnectionConfiguration(); }} onDeleteClient={async (id) => { await api.deleteOracleClient(id); await reloadConnectionConfiguration(); }} />}
      {closeTarget && <CloseDocumentDialog document={closeTarget} transactionChanged={closeTransactionChanged} onCancel={() => setPendingCloseId(undefined)} onCommit={() => { void transact('commit', closeTarget).then((done) => { if (done && !closeTarget.dirty) void finishClose(closeTarget.id); }); }} onRollback={() => { void transact('rollback', closeTarget).then((done) => { if (done && !closeTarget.dirty) void finishClose(closeTarget.id); }); }} onDiscard={() => { void discardAndClose(closeTarget); }} onSave={() => { void saveDocument(closeTarget.id).then((saved) => { if (saved) void finishClose(closeTarget.id); }); }} />}
      {conflictTarget && <FileConflictDialog document={conflictTarget} onCancel={() => setFileConflict(undefined)} onCompare={() => { if (!conflictTarget.filePath) return; void api.reopenSqlFile({ filePath: conflictTarget.filePath, encoding: conflictTarget.encoding }).then((opened) => setFileComparison({ documentId: conflictTarget.id, diskText: opened.text })).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error))); }} onReload={() => { if (!conflictTarget.filePath) return; void api.reopenSqlFile({ filePath: conflictTarget.filePath, encoding: conflictTarget.encoding }).then((opened) => { setWorkspace((current) => current ? updateDocument(current, conflictTarget.id, { ...openedFields(opened), dirty: false }) : current); setFileConflict(undefined); if (pendingCloseId === conflictTarget.id) void finishClose(conflictTarget.id); }).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error))); }} onSaveAs={() => { setFileConflict(undefined); void saveDocument(conflictTarget.id, true).then((saved) => { if (saved && pendingCloseId === conflictTarget.id) void finishClose(conflictTarget.id); }); }} onOverwrite={() => { setFileConflict(undefined); void saveDocument(conflictTarget.id, false, true).then((saved) => { if (saved && pendingCloseId === conflictTarget.id) void finishClose(conflictTarget.id); }); }} />}
      {fileComparison && <FileComparisonDialog document={workspace.documents.find((document) => document.id === fileComparison.documentId) ?? currentDocument} diskText={fileComparison.diskText} onClose={() => setFileComparison(undefined)} />}
      {encodingTarget && <EncodingDialog document={encodingTarget} onClose={() => setEncodingDocumentId(undefined)} onPreview={async (encoding) => encodingTarget.filePath ? (await api.reopenSqlFile({ filePath: encodingTarget.filePath, encoding })).text : encodingTarget.text} onApply={(encoding, bom, reopen) => { void applyEncoding(encoding, bom, reopen); }} />}
      {appClosePhase && <AppCloseDialog phase={appClosePhase} transactionCount={appTransactionCount} dirtyCount={appDirtyCount} onCancel={() => { setAppClosePhase(undefined); void api.confirmAppClose(false); }} onCommitAll={() => { void resolveAppTransactions('commit'); }} onRollbackAll={() => { void resolveAppTransactions('rollback'); }} onDiscardFiles={() => { void discardAllAndClose(); }} onSaveAll={() => { void saveAll().then((saved) => { if (saved) void api.confirmAppClose(true); }); }} />}
      {pendingSessionAction && currentDocument.connectionId && <SessionResetDialog action={pendingSessionAction} onCancel={() => setPendingSessionAction(undefined)} onConfirm={() => { const action = pendingSessionAction; setPendingSessionAction(undefined); void api[action]({ connectionId: currentDocument.connectionId as string, documentId: currentDocument.id, force: true }).catch((error: unknown) => setToast(error instanceof Error ? error.message : String(error))); }} />}
      {toast && <button className="toast" type="button" onClick={() => setToast(undefined)}>{toast}</button>}
    </div>
  );
}
