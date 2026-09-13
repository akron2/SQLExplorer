import type { LobCellValue, LobSubtype } from './contracts';

export const LOB_INLINE_TEXT_LIMIT = 8 * 1024;
export const LOB_READ_INITIAL = 8 * 1024;
export const LOB_READ_STEP = 64 * 1024;
export const LOB_BINARY_READ_STEP = 32 * 1024;
export const LOB_VIEW_TEXT_CAP = 1024 * 1024;
export const LOB_VIEW_BINARY_CAP = 1024 * 1024;
export const LOB_BUDGET_INITIAL_BYTES = 256 * 1024 * 1024;
export const LOB_BUDGET_STEP_BYTES = 256 * 1024 * 1024;
export const LOB_BUDGET_RESPONSE_TIMEOUT_MS = 120_000;
export const LOB_SAVE_CHUNK_BYTES = 1024 * 1024;
export const LOB_HEX_BYTES_PER_LINE = 16;
export const LOB_EXCEL_CELL_LIMIT = 32_000;
export const EXCEL_CELL_TEXT_LIMIT = 32_767;
export const EXCEL_MAX_ROWS_PER_SHEET = 1_048_575;

export const ENCODING_OPTIONS = [
  'utf8', 'utf16le', 'utf16be', 'utf32le', 'utf32be',
  'windows-1251', 'windows-1252', 'cp866', 'koi8-r', 'iso-8859-5',
  'shift_jis', 'gb18030', 'big5', 'euc-kr',
];

export function isLobCellValue(value: unknown): value is LobCellValue {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'lob';
}

export function isBinarySubtype(subtype: LobSubtype): boolean {
  return subtype === 'BLOB' || subtype === 'BFILE' || subtype === 'BYTEA';
}

export function lobFileExtension(subtype: LobSubtype): string {
  return isBinarySubtype(subtype) ? 'bin' : 'txt';
}

export function sanitizeFilePart(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/gu, '_')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/gu, '_')
    .replace(/^[._]+|[._]+$/gu, '')
    .slice(0, 60);
  return cleaned || 'value';
}

export function lobSuggestedFileName(columnName: string, rowIndex: number, subtype: LobSubtype): string {
  return `${sanitizeFilePart(columnName)}-${rowIndex}.${lobFileExtension(subtype)}`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ГБ`;
}

export function formatCharCount(chars: number): string {
  if (chars < 10_000) return `${chars.toLocaleString('ru-RU')} симв.`;
  if (chars < 1_000_000) return `${(chars / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс. симв.`;
  return `${(chars / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн симв.`;
}

export function lobCellLabel(cell: LobCellValue): string {
  const size = cell.size === null
    ? 'размер неизвестен'
    : cell.sizeUnit === 'bytes' ? formatByteSize(cell.size) : formatCharCount(cell.size);
  const suffix = cell.available ? '' : ' · недоступно';
  return `${cell.subtype} · ${size}${suffix}`;
}

export function adjustTextChunkEnd(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return end;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  const highSurrogate = last >= 0xd800 && last <= 0xdbff;
  const lowSurrogate = next >= 0xdc00 && next <= 0xdfff;
  return highSurrogate && lowSurrogate ? end + 1 : end;
}

export function sanitizeExcelText(value: string): string {
  return value
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('');
}

export function truncateExcelText(value: string): { text: string; truncated: boolean } {
  const sanitized = sanitizeExcelText(value);
  if (sanitized.length <= EXCEL_CELL_TEXT_LIMIT) return { text: sanitized, truncated: false };
  return { text: `${sanitized.slice(0, EXCEL_CELL_TEXT_LIMIT - 1)}…`, truncated: true };
}

export function excelLobLabel(cell: LobCellValue): string {
  return `[${lobCellLabel(cell)}]`;
}
