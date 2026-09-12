import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import type {
  CursorPosition,
  SqlCompletionItem,
  SqlCompletionRequest,
  SqlCompletionResult,
  SqlDocument,
} from '../../shared/contracts';
import { clampEditorFontSize, editorLineHeight } from './editor-font';
import { modelForDocument, updateEditorDiagnostics } from './editor-models';
import { DARK_EDITOR_THEME, defineEditorThemes, LIGHT_EDITOR_THEME } from './editor-themes';
import { statementAtOffset, statementRangeAtOffset } from './sql-selection';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const MAX_WINDOW_CHARS = 60_000;
const CONTEXT_BEFORE_CURSOR = 56_000;

const completionKinds: Record<SqlCompletionItem['kind'], monaco.languages.CompletionItemKind> = {
  alias: monaco.languages.CompletionItemKind.Variable,
  column: monaco.languages.CompletionItemKind.Field,
  cte: monaco.languages.CompletionItemKind.Struct,
  function: monaco.languages.CompletionItemKind.Function,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  matview: monaco.languages.CompletionItemKind.Struct,
  package: monaco.languages.CompletionItemKind.Module,
  procedure: monaco.languages.CompletionItemKind.Function,
  schema: monaco.languages.CompletionItemKind.Module,
  sequence: monaco.languages.CompletionItemKind.Value,
  synonym: monaco.languages.CompletionItemKind.Reference,
  table: monaco.languages.CompletionItemKind.Struct,
  type: monaco.languages.CompletionItemKind.Class,
  view: monaco.languages.CompletionItemKind.Struct,
};

export interface SqlEditorHandle {
  focus(): void;
  getSqlToExecute(): string;
  showSuggestions(): void;
}

interface SqlEditorProps {
  complete(request: SqlCompletionRequest): Promise<SqlCompletionResult>;
  document: SqlDocument;
  editorFontSize: number;
  onChange(documentId: string, text: string): void;
  onCursorChange(position: CursorPosition): void;
  onEditorFontSizeChange(fontSize: number): void;
  onExecute(): void;
  theme: 'light' | 'dark';
}

function toSuggestion(
  item: SqlCompletionItem,
  model: monaco.editor.ITextModel,
  windowBase: number,
): monaco.languages.CompletionItem {
  if (item.text === '…') {
    const point = model.getPositionAt(windowBase + item.replaceEnd);
    return {
      label: { label: item.text, description: item.detail },
      kind: monaco.languages.CompletionItemKind.Text,
      insertText: '',
      filterText: '…',
      range: {
        startLineNumber: point.lineNumber,
        startColumn: point.column,
        endLineNumber: point.lineNumber,
        endColumn: point.column,
      },
    };
  }
  const start = model.getPositionAt(windowBase + item.replaceStart);
  const end = model.getPositionAt(windowBase + item.replaceEnd);
  return {
    label: item.text,
    kind: completionKinds[item.kind],
    detail: item.detail,
    insertText: item.text,
    sortText: item.sortText,
    range: {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    },
  };
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { complete, document, editorFontSize, onChange, onCursorChange, onEditorFontSizeChange, onExecute, theme },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeDocumentRef = useRef(document);
  const completeRef = useRef(complete);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onEditorFontSizeChangeRef = useRef(onEditorFontSizeChange);
  const onExecuteRef = useRef(onExecute);
  const initialThemeRef = useRef(theme);
  const initialFontSizeRef = useRef(clampEditorFontSize(editorFontSize));
  const reportedFontSizeRef = useRef(initialFontSizeRef.current);
  const appliedFontSizeRef = useRef(initialFontSizeRef.current);
  const requestSequence = useRef(0);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const applyingExternalText = useRef(false);

  completeRef.current = complete;
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;
  onEditorFontSizeChangeRef.current = onEditorFontSizeChange;
  onExecuteRef.current = onExecute;

  useImperativeHandle(forwardedRef, () => ({
    focus: () => editorRef.current?.focus(),
    getSqlToExecute: () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return '';
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) return model.getValueInRange(selection).trim();
      const position = editor.getPosition();
      if (!position) return model.getValue().trim();
      return statementAtOffset(model.getValue(), model.getOffsetAt(position));
    },
    showSuggestions: () => {
      void editorRef.current?.getAction('editor.action.triggerSuggest')?.run();
      editorRef.current?.focus();
    },
  }));

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    defineEditorThemes(monaco);

    const viewStateCache = viewStates.current;
    const editor = monaco.editor.create(containerRef.current, {
      model: modelForDocument(activeDocumentRef.current),
      automaticLayout: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
      fontLigatures: true,
      fontSize: initialFontSizeRef.current,
      lineHeight: editorLineHeight(initialFontSizeRef.current),
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      padding: { top: 10, bottom: 12 },
      renderLineHighlight: 'all',
      roundedSelection: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      suggest: { preview: true, showStatusBar: true },
      tabSize: 2,
      theme: initialThemeRef.current === 'dark' ? DARK_EDITOR_THEME : LIGHT_EDITOR_THEME,
      wordWrap: 'off',
    });
    editorRef.current = editor;
    updateEditorDiagnostics(1);

    const initialViewState = activeDocumentRef.current.viewState;
    if (initialViewState) {
      editor.setPosition(initialViewState.cursor);
      editor.setScrollPosition({
        scrollLeft: initialViewState.scrollLeft,
        scrollTop: initialViewState.scrollTop,
      });
    }

    const changeDisposable = editor.onDidChangeModelContent(() => {
      if (applyingExternalText.current) return;
      const model = editor.getModel();
      if (model) onChangeRef.current(activeDocumentRef.current.id, model.getValue());
    });
    const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
      onCursorChangeRef.current({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });
    });
    const configurationDisposable = editor.onDidChangeConfiguration((event) => {
      if (!event.hasChanged(monaco.editor.EditorOption.fontSize)) return;
      const size = clampEditorFontSize(editor.getOption(monaco.editor.EditorOption.fontSize));
      if (size === reportedFontSizeRef.current) return;
      appliedFontSizeRef.current = size;
      reportedFontSizeRef.current = size;
      editor.updateOptions({ fontSize: size, lineHeight: editorLineHeight(size) });
      onEditorFontSizeChangeRef.current(size);
    });
    const applyFontSize = (size: number) => {
      const clamped = clampEditorFontSize(size);
      if (clamped === appliedFontSizeRef.current) return;
      appliedFontSizeRef.current = clamped;
      reportedFontSizeRef.current = clamped;
      editor.updateOptions({ fontSize: clamped, lineHeight: editorLineHeight(clamped) });
      onEditorFontSizeChangeRef.current(clamped);
    };
    const wheelListener = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY > 0 ? -1 : 1;
      applyFontSize(editor.getOption(monaco.editor.EditorOption.fontSize) + direction);
    };
    const wheelTarget = containerRef.current;
    wheelTarget.addEventListener('wheel', wheelListener, { capture: true, passive: false });
    editor.addCommand(monaco.KeyCode.F8, () => onExecuteRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onExecuteRef.current());
    editor.addCommand(monaco.KeyCode.F6, () => {
      void editor.getAction('editor.action.triggerSuggest')?.run();
    });

    const completionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems(model, position) {
        const active = activeDocumentRef.current;
        const offset = model.getOffsetAt(position);
        const fullText = model.getValue();
        const [statementStart, statementEnd] = statementRangeAtOffset(fullText, offset);
        let windowText = fullText.slice(statementStart, statementEnd);
        let cursorOffset = offset - statementStart;
        let windowBase = statementStart;
        if (windowText.length > MAX_WINDOW_CHARS) {
          const cut = Math.max(0, cursorOffset - CONTEXT_BEFORE_CURSOR);
          windowText = windowText.slice(cut, Math.min(windowText.length, cursorOffset + 4_000));
          cursorOffset -= cut;
          windowBase += cut;
        }
        const sequence = ++requestSequence.current;
        return completeRef.current({
          connectionId: active.connectionId,
          documentId: active.id,
          dialect: active.dialect,
          textWindow: windowText,
          cursorOffset,
        }).then((result) => {
          if (sequence !== requestSequence.current) return { suggestions: [] };
          const items = result?.items ?? [];
          return { suggestions: items.map((item) => toSuggestion(item, model, windowBase)) };
        }).catch(() => ({ suggestions: [] }));
      },
    });

    return () => {
      const finalViewState = editor.saveViewState();
      if (finalViewState) viewStateCache.set(activeDocumentRef.current.id, finalViewState);
      wheelTarget.removeEventListener('wheel', wheelListener, { capture: true });
      completionDisposable.dispose();
      configurationDisposable.dispose();
      cursorDisposable.dispose();
      changeDisposable.dispose();
      editor.dispose();
      editorRef.current = null;
      updateEditorDiagnostics(-1);
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = activeDocumentRef.current;
    if (previous.id === document.id) return;
    const previousState = editor.saveViewState();
    if (previousState) viewStates.current.set(previous.id, previousState);
    activeDocumentRef.current = document;
    editor.setModel(modelForDocument(document));
    const savedState = viewStates.current.get(document.id);
    if (savedState) editor.restoreViewState(savedState);
    else if (document.viewState) {
      editor.setPosition(document.viewState.cursor);
      editor.setScrollPosition({
        scrollLeft: document.viewState.scrollLeft,
        scrollTop: document.viewState.scrollTop,
      });
    }
    editor.focus();
  }, [document]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || activeDocumentRef.current.id !== document.id) return;
    const model = editor.getModel();
    if (!model || model.getValue() === document.text) return;
    applyingExternalText.current = true;
    try {
      model.setValue(document.text);
    } finally {
      applyingExternalText.current = false;
    }
  }, [document.id, document.text]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const size = clampEditorFontSize(editorFontSize);
    reportedFontSizeRef.current = size;
    if (size === appliedFontSizeRef.current) return;
    appliedFontSizeRef.current = size;
    editor.updateOptions({ fontSize: size, lineHeight: editorLineHeight(size) });
  }, [editorFontSize]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? DARK_EDITOR_THEME : LIGHT_EDITOR_THEME);
  }, [theme]);

  return <div className="sql-editor" ref={containerRef} data-testid="sql-editor" />;
});
