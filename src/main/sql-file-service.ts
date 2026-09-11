import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type {
  DiskFileVersion,
  OpenedSqlFile,
  OpenSqlFilesRequest,
  RecentSqlFile,
  ReopenSqlFileRequest,
  SaveSqlFileRequest,
  SaveSqlFileResult,
} from '../shared/contracts';
import {
  canonicalEncoding,
  decodeText,
  detectBom,
  detectEncoding,
  detectEol,
  encodeText,
  normalizeEol,
} from './sql-file-codec';
import type { WorkspaceStore } from './workspace-store';

const MAX_SQL_FILE_BYTES = 50 * 1024 * 1024;

function versionFromStat(stat: { mtimeMs: number; size: number }, content?: Buffer): DiskFileVersion {
  return {
    modifiedAtMs: stat.mtimeMs,
    size: stat.size,
    sha256: content ? createHash('sha256').update(content).digest('hex') : undefined,
  };
}

function sameVersion(left: DiskFileVersion, right: DiskFileVersion): boolean {
  return left.size === right.size
    && Math.abs(left.modifiedAtMs - right.modifiedAtMs) < 1
    && (!left.sha256 || !right.sha256 || left.sha256 === right.sha256);
}

async function atomicWrite(filePath: string, content: Buffer): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content, { flag: 'wx' });
  try {
    if (process.platform === 'win32') {
      await fs.copyFile(temporary, filePath);
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, filePath);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export class SqlFileService {
  constructor(private readonly store: WorkspaceStore) {}

  async chooseDirectory(window: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
    const options: Electron.OpenDialogOptions = {
      title: 'Выберите каталог',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  }

  async open(window: BrowserWindow | undefined, request: OpenSqlFilesRequest = {}): Promise<OpenedSqlFile[]> {
    let filePaths = request.paths;
    if (!filePaths?.length) {
      const options: Electron.OpenDialogOptions = {
        title: 'Открыть SQL-файл',
        filters: [
          { name: 'SQL scripts', extensions: ['sql', 'pls', 'pks', 'pkb'] },
          { name: 'Все файлы', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      filePaths = result.filePaths;
    }
    const unique = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))];
    return Promise.all(unique.map((filePath) => this.#read(filePath)));
  }

  reopen(request: ReopenSqlFileRequest): Promise<OpenedSqlFile> {
    return this.#read(path.resolve(request.filePath), request.encoding);
  }

  async save(
    window: BrowserWindow | undefined,
    request: SaveSqlFileRequest,
  ): Promise<SaveSqlFileResult> {
    let filePath = request.filePath ? path.resolve(request.filePath) : undefined;
    if (!filePath || request.saveAs) {
      const options: Electron.SaveDialogOptions = {
        title: 'Сохранить SQL-файл',
        defaultPath: filePath ?? request.title.replace(/\.sql$/iu, '') + '.sql',
        filters: [
          { name: 'SQL scripts', extensions: ['sql'] },
          { name: 'Все файлы', extensions: ['*'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { status: 'cancelled' };
      filePath = path.resolve(result.filePath);
    }

    if (!request.force && request.diskVersion && !request.saveAs) {
      try {
        const stat = await fs.stat(filePath);
        let currentVersion = versionFromStat(stat);
        if (sameVersion(request.diskVersion, currentVersion) && request.diskVersion.sha256) {
          currentVersion = versionFromStat(stat, await fs.readFile(filePath));
        }
        if (!sameVersion(request.diskVersion, currentVersion)) {
          return { status: 'conflict', currentVersion };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const text = normalizeEol(request.text, request.eol);
    const content = encodeText(text, request.encoding, request.bom);
    if (content.byteLength > MAX_SQL_FILE_BYTES) {
      throw new Error('SQL-файл превышает ограничение 50 MiB');
    }
    await atomicWrite(filePath, content);
    const saved = await this.#read(filePath, request.encoding);
    this.store.saveRecentFile(filePath, saved.title);
    return { status: 'saved', file: saved };
  }

  recent(): RecentSqlFile[] {
    return this.store.listRecentFiles();
  }

  async #read(filePath: string, forcedEncoding?: string): Promise<OpenedSqlFile> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Путь не является файлом: ${filePath}`);
    if (stat.size > MAX_SQL_FILE_BYTES) throw new Error('SQL-файл превышает ограничение 50 MiB');
    const bytes = await fs.readFile(filePath);
    const bom = detectBom(bytes);
    const content = bytes.subarray(bom.offset);
    const detected = forcedEncoding
      ? { encoding: canonicalEncoding(forcedEncoding), uncertain: false }
      : bom.encoding
        ? { encoding: bom.encoding, uncertain: false }
        : detectEncoding(content);
    const text = decodeText(content, detected.encoding);
    if (text.includes('\0') && !/^utf(?:16|32)/u.test(detected.encoding)) {
      throw new Error('Файл похож на бинарный. Выберите кодировку явно.');
    }
    const opened: OpenedSqlFile = {
      filePath,
      title: path.basename(filePath),
      text: text.replace(/\r\n|\r/gu, '\n'),
      encoding: detected.encoding,
      bom: bom.bom,
      eol: detectEol(text),
      diskVersion: versionFromStat(stat, bytes),
      uncertainEncoding: detected.uncertain,
    };
    this.store.saveRecentFile(filePath, opened.title);
    return opened;
  }
}
