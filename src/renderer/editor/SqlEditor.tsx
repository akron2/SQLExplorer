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
import type { CursorPosition, MetadataSnapshot, SqlDocument } from '../../shared/contracts';
import { modelForDocument, updateEditorDiagnostics } from './editor-models';
import { statementAtOffset } from './sql-selection';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

const sqlKeywords = [
  'select',
  'from',
  'where',
  'join',
  'left join',
  'right join',
  'inner join',
  'group by',
  'order by',
  'having',
  'insert into',
  'update',
  'delete from',
  'merge into',
  'commit',
  'rollback',
  'begin',
  'declare',
];

export interface SqlEditorHandle {
  focus(): void;
  getSqlToExecute(): string;
  showSuggestions(): void;
}

interface SqlEditorProps {
  document: SqlDocument;
  metadata?: MetadataSnapshot;
  onChange(documentId: string, text: string): void;
  onCursorChange(position: CursorPosition): void;
  onExecute(): void;
  theme: 'light' | 'dark';
}

function aliasColumns(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  metadata?: MetadataSnapshot,
) {
  const prefix = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const alias = prefix.match(/([a-z_][a-z0-9_$#]*)\.([a-z0-9_$#]*)$/iu)?.[1];
  if (!alias || !metadata) return undefined;
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const declaration = new RegExp(
    `(?:from|join)\\s+([a-z_][a-z0-9_$#.]*)\\s+(?:as\\s+)?${escapedAlias}\\b`,
    'iu',
  ).exec(prefix);
  const objectName = declaration?.[1]?.split('.').at(-1);
  return metadata.objects.find(
    (object) => object.name.toLocaleLowerCase() === objectName?.toLocaleLowerCase(),
  )?.columns;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { document, metadata, onChange, onCursorChange, onExecute, theme },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeDocumentRef = useRef(document);
  const metadataRef = useRef(metadata);
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onExecuteRef = useRef(onExecute);
  const initialThemeRef = useRef(theme);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());

  metadataRef.current = metadata;
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;
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

    monaco.editor.defineTheme('sqlexplorer-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'keyword.sql', foreground: '7B2CBF' },
        { token: 'string.sql', foreground: 'A34A1F' },
        { token: 'comment.sql', foreground: '77828D', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.lineHighlightBackground': '#F5F7F9',
        'editorLineNumber.foreground': '#7D8996',
        'editorLineNumber.activeForeground': '#243140',
        'editor.selectionBackground': '#CDECE7',
        'editorCursor.foreground': '#008F83',
      },
    });
    monaco.editor.defineTheme('sqlexplorer-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword.sql', foreground: 'C892FF' },
        { token: 'string.sql', foreground: 'F5A97F' },
        { token: 'comment.sql', foreground: '748393', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#11161C',
        'editor.lineHighlightBackground': '#192129',
        'editorLineNumber.foreground': '#657483',
        'editorLineNumber.activeForeground': '#DAE2EA',
        'editor.selectionBackground': '#164E4B',
        'editorCursor.foreground': '#48C9BB',
      },
    });

    const viewStateCache = viewStates.current;
    const editor = monaco.editor.create(containerRef.current, {
      model: modelForDocument(activeDocumentRef.current),
      automaticLayout: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontLigatures: true,
      fontSize: 13,
      lineHeight: 23,
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
      theme: initialThemeRef.current === 'dark' ? 'sqlexplorer-dark' : 'sqlexplorer-light',
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
      const model = editor.getModel();
      if (model) onChangeRef.current(activeDocumentRef.current.id, model.getValue());
    });
    const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
      onCursorChangeRef.current({
        lineNumber: event.position.lineNumber,
        column: event.position.column,
      });
    });
    editor.addCommand(monaco.KeyCode.F8, () => onExecuteRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onExecuteRef.current());
    editor.addCommand(monaco.KeyCode.F6, () => {
      void editor.getAction('editor.action.triggerSuggest')?.run();
    });

    const completionDisposable = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const scopedColumns = aliasColumns(model, position, metadataRef.current);
        const metadataItems = scopedColumns
          ? scopedColumns.map((column) => ({
              label: column.name,
              kind: monaco.languages.CompletionItemKind.Field,
              detail: column.dataType,
              insertText: column.name,
              range,
              sortText: `0-${column.position.toString().padStart(4, '0')}`,
            }))
          : (metadataRef.current?.objects.flatMap((object) => [
              {
                label: object.name,
                kind:
                  object.kind === 'table' || object.kind === 'view'
                    ? monaco.languages.CompletionItemKind.Struct
                    : monaco.languages.CompletionItemKind.Module,
                detail: `${object.kind} · ${object.schema}`,
                insertText: object.name,
                range,
                sortText: `1-${object.name}`,
              },
              ...(object.columns ?? []).map((column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                detail: `${column.dataType} · ${object.name}`,
                insertText: column.name,
                range,
                sortText: `2-${column.name}`,
              })),
            ]) ?? []);
        return {
          suggestions: [
            ...metadataItems,
            ...sqlKeywords.map((keyword) => ({
              label: keyword.toUpperCase(),
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: keyword,
              range,
              sortText: `9-${keyword}`,
            })),
          ],
        };
      },
    });

    return () => {
      const finalViewState = editor.saveViewState();
      if (finalViewState) viewStateCache.set(activeDocumentRef.current.id, finalViewState);
      completionDisposable.dispose();
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
    monaco.editor.setTheme(theme === 'dark' ? 'sqlexplorer-dark' : 'sqlexplorer-light');
  }, [theme]);

  return <div className="sql-editor" ref={containerRef} data-testid="sql-editor" />;
});
