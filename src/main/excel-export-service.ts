import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type {
  ExcelExportCancelRequest,
  ExcelExportFinishRequest,
  ExcelExportResult,
  ExcelExportRowsRequest,
  ExcelExportStartRequest,
  ExcelExportStartResult,
} from '../shared/contracts';
import { ExcelExportSession } from './excel-export';
import type { DatabaseRuntimeManager } from './database-runtime-manager';

export class ExcelExportService {
  readonly #sessions = new Map<string, ExcelExportSession>();

  constructor(private readonly databaseRuntime: DatabaseRuntimeManager) {}

  async start(window: BrowserWindow | undefined, request: ExcelExportStartRequest): Promise<ExcelExportStartResult> {
    const filePath = await this.#choosePath(window, request.suggestedName);
    if (!filePath) return { status: 'cancelled' };
    const lobDirectory = path.join(
      path.dirname(filePath),
      `${path.basename(filePath, path.extname(filePath))}.lobs`,
    );
    const session = new ExcelExportSession({
      columns: request.columns,
      executionId: request.executionId,
      filePath,
      lobDirectory,
      options: request.options,
      source: this.databaseRuntime,
    });
    this.#sessions.set(session.id, session);
    return {
      status: 'started',
      sessionId: session.id,
      targetPath: filePath,
      lobDirectory: session.lobDirectory,
    };
  }

  async writeRows(request: ExcelExportRowsRequest): Promise<void> {
    await this.#require(request.sessionId).writeRows(request.rows);
  }

  async finish(request: ExcelExportFinishRequest): Promise<ExcelExportResult> {
    const session = this.#require(request.sessionId);
    this.#sessions.delete(request.sessionId);
    try {
      return await session.finish();
    } catch (error) {
      await session.cancel().catch(() => undefined);
      throw error;
    }
  }

  async cancel(request: ExcelExportCancelRequest): Promise<void> {
    const session = this.#sessions.get(request.sessionId);
    if (!session) return;
    this.#sessions.delete(request.sessionId);
    await session.cancel();
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      await session.cancel().catch(() => undefined);
    }
  }

  #require(sessionId: string): ExcelExportSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error('Excel-экспорт больше недоступен');
    return session;
  }

  async #choosePath(window: BrowserWindow | undefined, suggestedName: string): Promise<string | undefined> {
    const options: Electron.SaveDialogOptions = {
      title: 'Экспорт в Excel',
      defaultPath: suggestedName,
      filters: [
        { name: 'Книга Excel', extensions: ['xlsx'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    return path.resolve(result.filePath);
  }
}
