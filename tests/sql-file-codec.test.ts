// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  bomBytes,
  canonicalEncoding,
  decodeText,
  detectBom,
  detectEncoding,
  detectEol,
  encodeText,
  normalizeEol,
} from '../src/main/sql-file-codec';

describe('SQL file codec', () => {
  it.each([
    ['utf8', 'none'],
    ['windows-1251', 'none'],
    ['cp866', 'none'],
    ['koi8-r', 'none'],
    ['utf16le', 'utf16le'],
    ['utf16be', 'utf16be'],
    ['utf32le', 'utf32le'],
    ['utf32be', 'utf32be'],
  ] as const)('round-trips %s with %s BOM', (encoding, bom) => {
    const source = 'select \'Привет, мир\' from dual;\r\n';
    const bytes = encodeText(source, encoding, bom);
    const detectedBom = detectBom(bytes);
    expect(detectedBom.bom).toBe(bom);
    expect(decodeText(bytes.subarray(detectedBom.offset), encoding)).toBe(source);
  });

  it('recognizes UTF-8 and exact BOMs before heuristic detection', () => {
    const utf8 = Buffer.from('select \'данные\';', 'utf8');
    expect(detectEncoding(utf8)).toEqual({ encoding: 'utf8', uncertain: false });
    expect(detectBom(Buffer.concat([bomBytes.utf8, utf8]))).toMatchObject({
      bom: 'utf8', encoding: 'utf8', offset: 3,
    });
  });

  it('preserves and converts line endings explicitly', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\rb\r')).toBe('cr');
    expect(normalizeEol('a\r\nb\nc\r', 'crlf')).toBe('a\r\nb\r\nc\r\n');
  });

  it('rejects a BOM that contradicts the selected encoding', () => {
    expect(() => encodeText('select 1;', 'windows-1251', 'utf8')).toThrow(/не соответствует/u);
  });

  it('refuses to replace characters that are absent from a legacy encoding', () => {
    expect(() => encodeText("select '🙂';", 'windows-1251', 'none')).toThrow(/нельзя сохранить/u);
  });

  it('normalizes common encoding aliases', () => {
    expect(canonicalEncoding('UTF-8')).toBe('utf8');
    expect(canonicalEncoding('IBM866')).toBe('cp866');
  });
});
