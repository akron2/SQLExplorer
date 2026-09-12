import type * as monaco from 'monaco-editor/editor/editor.api';

export const LIGHT_EDITOR_THEME = 'sqlexplorer-light';
export const DARK_EDITOR_THEME = 'sqlexplorer-dark';

type ThemeData = monaco.editor.IStandaloneThemeData;

export const lightEditorTheme: ThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword.sql', foreground: '7B2CBF' },
    { token: 'string.sql', foreground: 'A34A1F' },
    { token: 'comment.sql', foreground: '616D79', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.lineHighlightBackground': '#F5F7F9',
    'editorLineNumber.foreground': '#64707C',
    'editorLineNumber.activeForeground': '#243140',
    'editor.selectionBackground': '#CDECE7',
    'editorCursor.foreground': '#00756C',
  },
};

export const darkEditorTheme: ThemeData = {
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
    'editorLineNumber.foreground': '#808E9B',
    'editorLineNumber.activeForeground': '#DAE2EA',
    'editor.selectionBackground': '#164E4B',
    'editorCursor.foreground': '#48C9BB',
  },
};

export function defineEditorThemes(instance: typeof monaco): void {
  instance.editor.defineTheme(LIGHT_EDITOR_THEME, lightEditorTheme);
  instance.editor.defineTheme(DARK_EDITOR_THEME, darkEditorTheme);
}
