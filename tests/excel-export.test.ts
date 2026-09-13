// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ExcelJS from 'exceljs';
import type { LobChunkResult, LobCellValue, QueryColumn, QueryRow } from '../src/shared/contracts';
import { EXCEL_CELL_TEXT_LIMIT, LOB_EXCEL_CELL_LIMIT } from '../src/shared/lob';
import { ExcelExportSession, type LobAccess } from '../src/main/excel-export';

const createdDirs: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlexplorer-export-'));
  createdDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of createdDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const columns: QueryColumn[] = [
  { key: 'column-0', name: 'ID', typeName: 'NUMBER', nullable: false },
  { key: 'column-1', name: 'NAME', typeName: 'VARCHAR2', nullable: false },
  { key: 'column-2', name: 'DOC', typeName: 'CLOB', nullable: true },
  { key: 'column-3', name: 'PAYLOAD', typeName: 'BLOB', nullable: true },
];

const sourceText = `LOB-CONTENT-${'x'.repeat(50_000)}`;
const sourceBytes = Buffer.alloc(2048, 0x42);

function marker(subtype: LobCellValue['subtype'], size: number, unit: 'bytes' | 'chars', available = true): LobCellValue {
  return { kind: 'lob', subtype, size, sizeUnit: unit, available, ...(available ? {} : { note: 'budget' as const }) };
}

function createSource(): { calls: string[]; source: LobAccess } {
  const calls: string[] = [];
  const source: LobAccess = {
    readLob(request): Promise<LobChunkResult> {
      calls.push(`read:${request.columnIndex}:${request.offset}`);
      const data = sourceText.slice(request.offset, request.offset + request.length);
      return Promise.resolve({
        data,
        encoding: 'utf8',
        eof: request.offset + data.length >= sourceText.length,
        nextOffset: request.offset + data.length,
        offset: request.offset,
        size: sourceText.length,
        sizeUnit: 'chars',
        subtype: 'CLOB',
      });
    },
    saveLob(request, filePath) {
      calls.push(`save:${request.columnIndex}`);
      const content = request.columnIndex === 3 ? sourceBytes : Buffer.from(sourceText, 'utf8');
      fs.writeFileSync(filePath, content);
      return Promise.resolve({ status: 'saved' as const, filePath, bytes: content.byteLength });
    },
  };
  return { calls, source };
}

function session(directory: string, source: LobAccess, lobMode: 'files' | 'markers' | 'partial'): ExcelExportSession {
  return new ExcelExportSession({
    columns,
    executionId: 'exec-1',
    filePath: path.join(directory, 'export.xlsx'),
    lobDirectory: path.join(directory, 'export.lobs'),
    options: { lobMode },
    source,
  });
}

const rows: QueryRow[] = [
  {
    index: 1,
    cells: ['1', 'plain', marker('CLOB', sourceText.length, 'chars'), marker('BYTEA', sourceBytes.byteLength, 'bytes')],
  },
  {
    index: 2,
    cells: ['2', 'y'.repeat(40_000), marker('CLOB', 5000, 'chars', false), null],
  },
];

describe('ExcelExportSession', () => {
  it('writes files mode rows with relative hyperlinks and real LOB files', async () => {
    const directory = tempDir();
    const { calls, source } = createSource();
    const exportSession = session(directory, source, 'files');
    await exportSession.writeRows(rows);
    const result = await exportSession.finish();

    expect(result.rows).toBe(2);
    expect(result.lobFiles).toBe(2);
    expect(calls).toContain('save:2');
    expect(calls).toContain('save:3');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    const sheet = workbook.getWorksheet('Результат');
    expect(sheet?.getCell('A2').value).toBe('1');
    expect(sheet?.getCell('B2').value).toBe('plain');
    const docCell = sheet?.getCell('C2').value as { hyperlink?: string; text?: string };
    expect(docCell.text).toContain('CLOB');
    expect(docCell.hyperlink).toBe('export.lobs/000001-DOC.txt');
    const payloadCell = sheet?.getCell('D2').value as { hyperlink?: string };
    expect(payloadCell.hyperlink).toBe('export.lobs/000001-PAYLOAD.bin');
    expect(fs.readFileSync(path.join(directory, docCell.hyperlink as string), 'utf8')).toBe(sourceText);
    expect(fs.readFileSync(path.join(directory, payloadCell.hyperlink as string)).equals(sourceBytes)).toBe(true);

    const truncated = sheet?.getCell('B3').value as string;
    expect(truncated.length).toBe(EXCEL_CELL_TEXT_LIMIT);
    expect(truncated.endsWith('…')).toBe(true);
    const unavailable = sheet?.getCell('C3').value as string;
    expect(unavailable).toContain('недоступно');
    expect(result.warnings.some((warning) => warning.includes('усечён'))).toBe(true);
  });

  it('exports partial text LOBs up to the cell budget and keeps binary markers', async () => {
    const directory = tempDir();
    const { calls, source } = createSource();
    const exportSession = session(directory, source, 'partial');
    await exportSession.writeRows(rows);
    const result = await exportSession.finish();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    const sheet = workbook.getWorksheet('Результат');
    const docCell = sheet?.getCell('C2').value as string;
    expect(docCell.startsWith('LOB-CONTENT-')).toBe(true);
    expect(docCell.length).toBe(LOB_EXCEL_CELL_LIMIT + 1);
    expect(docCell.endsWith('…')).toBe(true);
    const payloadCell = sheet?.getCell('D2').value as string;
    expect(payloadCell).toContain('BYTEA');
    expect(result.lobFiles).toBe(0);
    expect(calls.some((call) => call.startsWith('save:'))).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('усечены'))).toBe(true);
  });

  it('keeps markers only when requested', async () => {
    const directory = tempDir();
    const { calls, source } = createSource();
    const exportSession = session(directory, source, 'markers');
    await exportSession.writeRows(rows);
    const result = await exportSession.finish();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.filePath);
    const sheet = workbook.getWorksheet('Результат');
    expect(sheet?.getCell('C2').value).toContain('CLOB');
    expect(sheet?.getCell('D2').value).toContain('BYTEA');
    expect(calls).toEqual([]);
    expect(result.lobFiles).toBe(0);
  });

  it('removes incomplete artifacts on cancel', async () => {
    const directory = tempDir();
    const { source } = createSource();
    const exportSession = session(directory, source, 'files');
    await exportSession.writeRows(rows);
    await exportSession.cancel();

    expect(fs.existsSync(exportSession.filePath)).toBe(false);
    expect(fs.existsSync(exportSession.lobDirectory)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
