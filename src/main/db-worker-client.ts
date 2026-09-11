import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  DatabaseErrorInfo,
  DatabaseRuntimeConfiguration,
  WorkerEvent,
  WorkerMessage,
  WorkerMethod,
  WorkerRequest,
} from '../shared/contracts';

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

export class DatabaseOperationError extends Error {
  readonly code?: string;
  readonly kind: DatabaseErrorInfo['kind'];
  readonly retryable: boolean;

  constructor(info: DatabaseErrorInfo & { stack?: string }) {
    super(info.message);
    this.name = 'DatabaseOperationError';
    this.code = info.code;
    this.kind = info.kind;
    this.retryable = info.retryable;
    if (info.stack) this.stack = info.stack;
  }

  serialize(): DatabaseErrorInfo {
    return { code: this.code, kind: this.kind, message: this.message, retryable: this.retryable };
  }
}

export class DatabaseWorkerClient extends EventEmitter {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #process: UtilityProcess;
  readonly runtimeKey: string;
  #closed = false;

  constructor(buildDirectory: string, configuration: DatabaseRuntimeConfiguration) {
    super();
    this.runtimeKey = configuration.runtimeKey;
    this.#process = utilityProcess.fork(path.join(buildDirectory, 'db-worker.js'), [], {
      cwd: process.cwd(),
      env: { ...process.env, SQLX_RUNTIME_CONFIG: JSON.stringify(configuration) },
      serviceName: `SQLExplorer DB · ${configuration.runtimeKey}`,
      stdio: process.env.NODE_ENV === 'development' ? 'inherit' : 'ignore',
    });
    this.#process.on('message', (message: WorkerMessage) => {
      if (message.type === 'event') {
        this.emit('worker-event', message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new DatabaseOperationError(message.error));
      else pending.resolve(message.result);
    });
    this.#process.on('error', (_type, location) => {
      this.#rejectAll(new Error(`Database runtime failed at ${location}`));
    });
    this.#process.on('exit', (code) => {
      this.#closed = true;
      this.#rejectAll(new Error(`Database runtime ${this.runtimeKey} stopped with exit code ${code}`));
      this.emit('runtime-exit', code);
    });
  }

  call<T>(method: WorkerMethod, payload: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`Database runtime ${this.runtimeKey} is closed`));
    const request: WorkerRequest = { type: 'request', id: randomUUID(), method, payload };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(request.id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#process.postMessage(request);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.call<void>('close', undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.#closed = true;
      this.#process.kill();
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export type DatabaseWorkerEvent = WorkerEvent;
