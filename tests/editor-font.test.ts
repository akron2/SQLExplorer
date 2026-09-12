// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { clampEditorFontSize, editorLineHeight } from '../src/renderer/editor/editor-font';

describe('editor font helpers', () => {
  it('keeps the size inside the supported range and rounds fractions', () => {
    expect(clampEditorFontSize(14)).toBe(14);
    expect(clampEditorFontSize(10.4)).toBe(11);
    expect(clampEditorFontSize(24.6)).toBe(24);
    expect(clampEditorFontSize(15.6)).toBe(16);
  });

  it('falls back to the default for a broken value', () => {
    expect(clampEditorFontSize(Number.NaN)).toBe(14);
    expect(clampEditorFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });

  it('keeps the current airy line height at the default size and scales it with the font', () => {
    expect(editorLineHeight(14)).toBe(24);
    expect(editorLineHeight(11)).toBe(19);
    expect(editorLineHeight(24)).toBe(41);
  });
});
