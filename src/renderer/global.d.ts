import type { SQLExplorerApi } from '../shared/contracts';

declare global {
  interface Window {
    sqlExplorer?: SQLExplorerApi;
  }

  interface Window {
    MonacoEnvironment?: {
      getWorker(moduleId: string, label: string): Worker;
    };
  }
}

export {};
