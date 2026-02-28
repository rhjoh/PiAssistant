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
    model?: string;
    provider?: string;
  };
}

export interface StatusProvider {
  getStatus(): FileServerStatus;
  recordHeartbeat(): void;
  recordMemoryWatcherRun(): void;
}
