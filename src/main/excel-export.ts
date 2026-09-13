import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import type {
  ExcelExportOptions,
  ExcelExportResult,
  LobCellValue,
  LobChunkResult,
  LobReadRequest,
  LobSaveRequest,
  LobSaveResult,
  QueryColumn,
  QueryRow,
} from '../shared/contracts';
import {
  EXCEL_CELL_TEXT_LIMIT,
  EXCEL_MAX_ROWS_PER_SHEET,
  LOB_EXCEL_CELL_LIMIT,
  excelLobLabel,
  isBinarySubtype,
  isLobCellValue,
  lobFileExtension,
  sanitizeFilePart,
  truncateExcelText,
} from '../shared/lob';

export interface LobAccess {
  readLob(request: LobReadRequest): Promise<LobChunkResult>;
  saveLob(request: LobSaveRequest, filePath: string): Promise<LobSaveResult>;
}

export interface ExcelExportSessionOptions {
  columns: QueryColumn[];
  executionId: string;
  filePath: string;
  lobDirectory: string;
  options: ExcelExportOptions;
  source: LobAccess;
}

interface SavedLobFile {
  filePath: string;
  relativePath: string;
}

export class ExcelExportSession {
  readonly id = randomUUID();
  readonly #columns: QueryColumn[];
  readonly #createdFiles: string[] = [];
  readonly #executionId: string;
  readonly #filePath: string;
  readonly #lobDirectory: string;
  readonly #options: ExcelExportOptions;
  readonly #source: LobAccess;
  readonly #warnings = new Set<string>();
  readonly #workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  #lobDirectoryCreated = false;
  #lobFiles = 0;
  #rowCount = 0;
  #sheet: ExcelJS.Worksheet;
  #sheetIndex = 1;

  constructor(options: ExcelExportSessionOptions) {
    this.#columns = options.columns;
    this.#executionId = options.executionId;
    this.#filePath = options.filePath;
    this.#lobDirectory = options.lobDirectory;
    this.#options = options.options;
    this.#source = options.source;
    this.#workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: options.filePath,
      useSharedStrings: false,
      useStyles: true,
    });
    this.#sheet = this.#addSheet(1);
  }

  get filePath(): string {
    return this.#filePath;
  }

  get lobDirectory(): string {
    return this.#lobDirectory;
  }

  async writeRows(rows: QueryRow[]): Promise<void> {
    for (const row of rows) {
      if (this.#rowCount > 0 && this.#rowCount % EXCEL_MAX_ROWS_PER_SHEET === 0) {
        this.#sheet.commit();
        this.#sheetIndex += 1;
        this.#sheet = this.#addSheet(this.#sheetIndex);
      }
      const values: ExcelJS.CellValue[] = [];
      for (let columnIndex = 0; columnIndex < this.#columns.length; columnIndex += 1) {
        values.push(await this.#cellValue(row, row.cells[columnIndex], columnIndex));
      }
      this.#sheet.addRow(values).commit();
      this.#rowCount += 1;
    }
  }

  async finish(): Promise<ExcelExportResult> {
    this.#sheet.commit();
    await this.#workbook.commit();
    return {
      filePath: this.#filePath,
      lobFiles: this.#lobFiles,
      rows: this.#rowCount,
      warnings: [...this.#warnings],
    };
  }

  async cancel(): Promise<void> {
    try {
      await this.#workbook.commit();
    } catch {
      // The workbook may be incomplete; artifacts are removed below.
    }
    await this.#cleanup();
  }

  #addSheet(index: number): ExcelJS.Worksheet {
    const sheet = this.#workbook.addWorksheet(index === 1 ? 'Результат' : `Результат ${index}`);
    sheet.columns = this.#columns.map((column) => ({
      width: Math.max(10, Math.min(44, column.name.length + 4)),
    }));
    const header = sheet.addRow(this.#columns.map((column) => column.name));
    header.font = { bold: true };
    header.commit();
    return sheet;
  }

  #note(message: string): void {
    this.#warnings.add(message);
  }

  async #cellValue(row: QueryRow, value: QueryRow['cells'][number], columnIndex: number): Promise<ExcelJS.CellValue> {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      const { text, truncated } = truncateExcelText(value);
      if (truncated) this.#note(`Текст в ячейках усечён до лимита Excel ${EXCEL_CELL_TEXT_LIMIT} символов`);
      return text;
    }
    if (!isLobCellValue(value)) return null;
    const label = excelLobLabel(value);
    if (!value.available) {
      this.#note('Часть LOB-значений недоступна (лимит памяти или истёкшее исполнение)');
      return label;
    }
    if (this.#options.lobMode === 'markers') return label;
    if (this.#options.lobMode === 'partial') {
      if (isBinarySubtype(value.subtype)) return label;
      const text = await this.#readPartialLob(value, row.index, columnIndex);
      return text ?? label;
    }
    const saved = await this.#saveLobFile(value, row.index, columnIndex);
    if (!saved) return label;
    return { text: label, hyperlink: saved.relativePath, tooltip: path.basename(saved.filePath) };
  }

  async #readPartialLob(value: LobCellValue, rowIndex: number, columnIndex: number): Promise<string | undefined> {
    try {
      let offset = 0;
      let text = '';
      let reachedEnd = false;
      while (text.length < LOB_EXCEL_CELL_LIMIT) {
        const chunk = await this.#source.readLob({
          executionId: this.#executionId,
          rowIndex,
          columnIndex,
          offset,
          length: Math.min(65_536, LOB_EXCEL_CELL_LIMIT - text.length),
        });
        if (chunk.encoding !== 'utf8') return undefined;
        text += chunk.data;
        offset = chunk.nextOffset;
        if (chunk.eof) {
          reachedEnd = true;
          break;
        }
      }
      if (!reachedEnd && value.size !== null && value.size > text.length) {
        this.#note(`Текстовые LOB усечены до ${LOB_EXCEL_CELL_LIMIT} символов в ячейке`);
      }
      const { text: truncated, truncated: wasTruncated } = truncateExcelText(text);
      if (wasTruncated) this.#note(`Текст в ячейках усечён до лимита Excel ${EXCEL_CELL_TEXT_LIMIT} символов`);
      return wasTruncated || reachedEnd ? truncated : `${truncated}…`;
    } catch (error) {
      this.#note(`Не удалось прочитать LOB (строка ${rowIndex}): ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #saveLobFile(value: LobCellValue, rowIndex: number, columnIndex: number): Promise<SavedLobFile | undefined> {
    const columnName = this.#columns[columnIndex]?.name ?? `column-${columnIndex + 1}`;
    const fileName = `${String(rowIndex).padStart(6, '0')}-${sanitizeFilePart(columnName)}.${lobFileExtension(value.subtype)}`;
    const filePath = path.join(this.#lobDirectory, fileName);
    try {
      await fs.mkdir(this.#lobDirectory, { recursive: true });
      this.#lobDirectoryCreated = true;
      const saved = await this.#source.saveLob({
        executionId: this.#executionId,
        rowIndex,
        columnIndex,
        suggestedName: fileName,
      }, filePath);
      if (saved.status !== 'saved') {
        this.#note(`LOB строки ${rowIndex} не сохранён: значение недоступно`);
        return undefined;
      }
      this.#lobFiles += 1;
      this.#createdFiles.push(filePath);
      const relativePath = path.relative(path.dirname(this.#filePath), filePath).split(path.sep).join('/');
      return { filePath, relativePath };
    } catch (error) {
      this.#note(`LOB строки ${rowIndex} не сохранён: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  async #cleanup(): Promise<void> {
    await fs.rm(this.#filePath, { force: true }).catch(() => undefined);
    for (const file of this.#createdFiles) {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
    if (this.#lobDirectoryCreated) {
      await fs.rmdir(this.#lobDirectory).catch(() => undefined);
    }
  }
}
