import chardet from 'chardet';
import iconv from 'iconv-lite';
import type { TextFileBom, TextFileEol } from '../shared/contracts';

export const bomBytes: Record<Exclude<TextFileBom, 'none'>, Buffer> = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
  utf16be: Buffer.from([0xfe, 0xff]),
  utf32le: Buffer.from([0xff, 0xfe, 0x00, 0x00]),
  utf32be: Buffer.from([0x00, 0x00, 0xfe, 0xff]),
};

export function canonicalEncoding(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  const aliases: Record<string, string> = {
    'utf-8': 'utf8',
    'utf-16le': 'utf16le',
    'utf-16be': 'utf16be',
    'utf-32le': 'utf32le',
    'utf-32be': 'utf32be',
    ascii: 'utf8',
    ibm866: 'cp866',
  };
  return aliases[normalized] ?? normalized;
}

export function detectBom(buffer: Buffer): { bom: TextFileBom; offset: number; encoding?: string } {
  if (buffer.subarray(0, 4).equals(bomBytes.utf32be)) return { bom: 'utf32be', offset: 4, encoding: 'utf32be' };
  if (buffer.subarray(0, 4).equals(bomBytes.utf32le)) return { bom: 'utf32le', offset: 4, encoding: 'utf32le' };
  if (buffer.subarray(0, 3).equals(bomBytes.utf8)) return { bom: 'utf8', offset: 3, encoding: 'utf8' };
  if (buffer.subarray(0, 2).equals(bomBytes.utf16be)) return { bom: 'utf16be', offset: 2, encoding: 'utf16be' };
  if (buffer.subarray(0, 2).equals(bomBytes.utf16le)) return { bom: 'utf16le', offset: 2, encoding: 'utf16le' };
  return { bom: 'none', offset: 0 };
}

function strictUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function detectEncoding(buffer: Buffer): { encoding: string; uncertain: boolean } {
  if (strictUtf8(buffer)) return { encoding: 'utf8', uncertain: false };
  const match = chardet.analyse(buffer)[0];
  const encoding = canonicalEncoding(match?.name ?? 'windows-1251');
  if (!iconv.encodingExists(encoding)) return { encoding: 'windows-1251', uncertain: true };
  return { encoding, uncertain: !match || match.confidence < 60 };
}

export function decodeText(buffer: Buffer, encoding: string): string {
  const canonical = canonicalEncoding(encoding);
  if (!iconv.encodingExists(canonical)) throw new Error(`Кодировка не поддерживается: ${encoding}`);
  return iconv.decode(buffer, canonical);
}

export function detectEol(text: string): TextFileEol {
  const crlf = text.match(/\r\n/gu)?.length ?? 0;
  const withoutCrlf = text.replaceAll('\r\n', '');
  const lf = withoutCrlf.match(/\n/gu)?.length ?? 0;
  const cr = withoutCrlf.match(/\r/gu)?.length ?? 0;
  if (crlf >= lf && crlf >= cr && crlf > 0) return 'crlf';
  if (cr > lf && cr > 0) return 'cr';
  return 'lf';
}

export function normalizeEol(text: string, eol: TextFileEol): string {
  const sequence = eol === 'crlf' ? '\r\n' : eol === 'cr' ? '\r' : '\n';
  return text.replace(/\r\n|\r|\n/gu, sequence);
}

export function encodeText(text: string, encoding: string, bom: TextFileBom): Buffer {
  const canonical = canonicalEncoding(encoding);
  if (!iconv.encodingExists(canonical)) throw new Error(`Кодировка не поддерживается: ${encoding}`);
  if (bom !== 'none' && canonical !== bom) {
    throw new Error(`BOM ${bom.toUpperCase()} не соответствует кодировке ${canonical.toUpperCase()}`);
  }
  const content = iconv.encode(text, canonical);
  if (iconv.decode(content, canonical) !== text) {
    throw new Error(`Текст содержит символы, которые нельзя сохранить в кодировке ${canonical.toUpperCase()}. Выберите UTF-8 или другую Unicode-кодировку.`);
  }
  return bom === 'none' ? content : Buffer.concat([bomBytes[bom], content]);
}
