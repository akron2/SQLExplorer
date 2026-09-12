import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { darkEditorTheme, lightEditorTheme } from '../src/renderer/editor/editor-themes';

const css = readFileSync(path.resolve(__dirname, '../src/renderer/styles.css'), 'utf8');

function themeTokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Block ${selector} not found in styles.css`);
  const tokens: Record<string, string> = {};
  for (const match of css.slice(start, end).matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/giu)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

function channel(hex: string): number {
  const value = parseInt(hex, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

const requiredPairs: Array<[string, string]> = [
  ['text', 'app-bg'],
  ['text', 'panel'],
  ['text', 'panel-strong'],
  ['text-soft', 'app-bg'],
  ['text-soft', 'panel'],
  ['text-soft', 'chrome'],
  ['text-soft', 'panel-strong'],
  ['text-faint', 'app-bg'],
  ['text-faint', 'panel'],
  ['text-faint', 'chrome'],
  ['text-faint', 'panel-strong'],
  ['text', 'accent-soft'],
  ['text-soft', 'accent-soft'],
  ['accent', 'app-bg'],
  ['accent', 'panel-strong'],
  ['accent', 'accent-soft'],
  ['accent-hover', 'accent-soft'],
  ['accent-contrast', 'accent'],
  ['danger', 'app-bg'],
  ['danger', 'danger-soft'],
  ['warning', 'app-bg'],
  ['warning', 'warning-soft'],
  ['oracle', 'app-bg'],
  ['oracle', 'chrome'],
  ['postgres', 'app-bg'],
  ['postgres', 'chrome'],
];

describe.each([
  ['light', ':root'],
  ['dark', ':root[data-theme="dark"]'],
])('%s theme contrast (WCAG AA)', (name, selector) => {
  const tokens = themeTokens(selector);

  it('defines every color token used by the app', () => {
    for (const token of new Set(requiredPairs.flat())) {
      expect(tokens[token], `token --${token} in ${name} theme`).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  it.each(requiredPairs)('--%s on --%s is at least 4.5:1', (foreground, background) => {
    const ratio = contrast(tokens[foreground], tokens[background]);
    expect(ratio, `contrast of --${foreground} on --${background} in ${name} theme is ${ratio.toFixed(2)}`)
      .toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe.each([
  ['light', lightEditorTheme, '#FFFFFF'],
  ['dark', darkEditorTheme, '#11161C'],
])('%s editor theme contrast', (name, theme, background) => {
  it.each(theme.rules ?? [])('token $token is readable on the editor background', (rule) => {
    expect(rule.foreground).toBeTypeOf('string');
    const ratio = contrast(`#${rule.foreground}`, background);
    expect(ratio, `contrast of editor token ${rule.token} in ${name} theme is ${ratio.toFixed(2)}`)
      .toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('keeps line numbers readable', () => {
    const lineNumber = theme.colors?.['editorLineNumber.foreground'] ?? '';
    const ratio = contrast(lineNumber, background);
    expect(ratio, `line number contrast in ${name} theme is ${ratio.toFixed(2)}`)
      .toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('typography tokens', () => {
  it('uses size tokens everywhere instead of raw pixel font sizes', () => {
    expect(css).not.toMatch(/font-size:\s*\d+px/u);
    expect(css).toMatch(/--font-xs:\s*calc\(12px \* var\(--ui-scale\)\)/u);
    expect(css).toMatch(/--font-sm:\s*calc\(13px \* var\(--ui-scale\)\)/u);
    expect(css).toMatch(/--font-md:\s*calc\(14px \* var\(--ui-scale\)\)/u);
    expect(css).toMatch(/--font-lg:\s*calc\(16px \* var\(--ui-scale\)\)/u);
  });

  it('uses the bundled font stacks instead of system-only stacks', () => {
    expect(css).toMatch(/--font-family-ui:\s*"Inter Variable"/u);
    expect(css).toMatch(/--font-family-mono:\s*"JetBrains Mono Variable"/u);
    expect(css).not.toMatch(/font-family:\s*Consolas/u);
    expect(css).not.toMatch(/font-family:\s*"Cascadia Code"/u);
  });
});
