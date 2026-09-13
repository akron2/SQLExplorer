// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { LobCellValue } from '../src/shared/contracts';
import {
  adjustTextChunkEnd,
  formatByteSize,
  formatCharCount,
  isBinarySubtype,
  isLobCellValue,
  lobCellLabel,
  lobFileExtension,
  lobSuggestedFileName,
  sanitizeFilePart,
} from '../src/shared/lob';

describe('LOB helpers', () => {
  it('formats byte sizes with Russian units', () => {
    expect(formatByteSize(512)).toBe('512 Б');
    expect(formatByteSize(2048)).toBe('2 КБ');
    expect(formatByteSize(1024 * 1024)).toBe('1 МБ');
    expect(formatByteSize(3 * 1024 * 1024 * 1024)).toBe('3 ГБ');
  });

  it('formats character counts', () => {
    expect(formatCharCount(999)).toBe('999 симв.');
    expect(formatCharCount(25_000)).toContain('тыс. симв.');
    expect(formatCharCount(2_500_000)).toContain('млн симв.');
  });

  it('labels available and unavailable markers', () => {
    const available: LobCellValue = {
      kind: 'lob', subtype: 'CLOB', size: 2048, sizeUnit: 'chars', available: true,
    };
    expect(lobCellLabel(available)).toBe('CLOB · 2\u00a0048 симв.');
    const unavailable: LobCellValue = {
      kind: 'lob', subtype: 'BYTEA', size: 1024 * 1024, sizeUnit: 'bytes', available: false, note: 'budget',
    };
    expect(lobCellLabel(unavailable)).toBe('BYTEA · 1 МБ · недоступно');
    const unknown: LobCellValue = {
      kind: 'lob', subtype: 'BFILE', size: null, sizeUnit: 'bytes', available: true,
    };
    expect(lobCellLabel(unknown)).toBe('BFILE · размер неизвестен');
  });

  it('detects LOB markers', () => {
    expect(isLobCellValue({ kind: 'lob', subtype: 'CLOB', size: 1, sizeUnit: 'chars', available: true })).toBe(true);
    expect(isLobCellValue('CLOB')).toBe(false);
    expect(isLobCellValue(null)).toBe(false);
    expect(isLobCellValue({ kind: 'other' })).toBe(false);
  });

  it('classifies binary subtypes', () => {
    expect(isBinarySubtype('BLOB')).toBe(true);
    expect(isBinarySubtype('BFILE')).toBe(true);
    expect(isBinarySubtype('BYTEA')).toBe(true);
    expect(isBinarySubtype('CLOB')).toBe(false);
    expect(isBinarySubtype('TEXT')).toBe(false);
    expect(lobFileExtension('BLOB')).toBe('bin');
    expect(lobFileExtension('TEXT')).toBe('txt');
  });

  it('keeps surrogate pairs intact at chunk boundaries', () => {
    const value = 'ab\uD83D\uDE00cd';
    expect(adjustTextChunkEnd(value, 0)).toBe(0);
    expect(adjustTextChunkEnd(value, value.length)).toBe(value.length);
    expect(adjustTextChunkEnd(value, 3)).toBe(4);
    expect(adjustTextChunkEnd(value, 2)).toBe(2);
  });

  it('builds safe file names', () => {
    expect(sanitizeFilePart('NOTES')).toBe('NOTES');
    expect(sanitizeFilePart('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeFilePart('   ')).toBe('value');
    expect(lobSuggestedFileName('NOTES', 12, 'CLOB')).toBe('NOTES-12.txt');
    expect(lobSuggestedFileName('payload', 3, 'BYTEA')).toBe('payload-3.bin');
  });
});
