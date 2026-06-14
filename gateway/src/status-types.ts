export interface ApiServerStatus {
  websocket: {
    running: boolean;
    host?: string;
    port: number;
    clientCount: number;
    clients: Array<{ id: string; type: string }>;
  };
  heartbeat: {
    lastRunAt: string | null;
    intervalMs: number;
  };
  dailyContext?: {
    lastRunAt: string | null;
  };
  memoryWatcher?: {
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
  getStatus(): Promise<ApiServerStatus> | ApiServerStatus;
  recordHeartbeat(): void;
  recordDailyContextRun(): void;
}
