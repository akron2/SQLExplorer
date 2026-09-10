import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { WorkerMethod, WorkerRequest, WorkerResponse } from '../shared/contracts';

interface PendingRequest {
  reject(error: Error): void;
  resolve(value: unknown): void;
}

export class DatabaseWorkerClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #worker: Worker;

  constructor(buildDirectory: string) {
    this.#worker = new Worker(path.join(buildDirectory, 'db-worker.js'));
    this.#worker.on('message', (response: WorkerResponse) => {
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) {
        const error = new Error(response.error.message);
        error.name = response.error.code ?? 'DatabaseWorkerError';
        if (response.error.stack) error.stack = response.error.stack;
        pending.reject(error);
      } else {
        pending.resolve(response.result);
      }
    });
    this.#worker.on('error', (error: Error) => this.#rejectAll(error));
    this.#worker.on('exit', (code) => {
      if (code !== 0) this.#rejectAll(new Error(`Database worker stopped with exit code ${code}`));
    });
  }

  call<T>(method: WorkerMethod, payload: unknown): Promise<T> {
    const request: WorkerRequest = { id: randomUUID(), method, payload };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(request.id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    try {
      await this.call<void>('close', undefined);
    } finally {
      await this.#worker.terminate();
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
