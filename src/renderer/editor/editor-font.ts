import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from '../../shared/contracts';

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return 14;
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)));
}

export function editorLineHeight(fontSize: number): number {
  return Math.max(16, Math.round(fontSize * (12 / 7)));
}
