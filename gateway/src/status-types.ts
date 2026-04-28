export interface FileServerStatus {
  websocket: {
    running: boolean;
    port: number;
    clientCount: number;
    clients: Array<{ id: string; type: string }>;
  };
  heartbeat: {
    lastRunAt: string | null;
    intervalMs: number;
  };
  memoryWatcher: {
    lastRunAt: string | null;
    intervalMs: number;
    enabled: boolean;
  };
  session: {
    path: string;
    model?: { id: string; name: string; provider: string; contextWindow?: number };
    contextTokens?: number;
    contextWindow?: number;
  };
}

export interface StatusProvider {
  getStatus(): Promise<FileServerStatus> | FileServerStatus;
  recordHeartbeat(): void;
  recordMemoryWatcherRun(): void;
}
