import type { BroadcastManager } from "./broadcast.js";
import type { PiRpcClient } from "./pi-rpc.js";
import type { FileServerStatus, StatusProvider } from "./status-types.js";

export class GatewayStatusProvider implements StatusProvider {
  private heartbeatLastRun: Date | null = null;
  private memoryWatcherLastRun: Date | null = null;
  private wsRunning = false;

  constructor(
    private broadcastManager: BroadcastManager,
    private pi: PiRpcClient,
    private sessionPath: string,
    private wsPort: number,
    private heartbeatIntervalMs: number,
    private memoryWatcherIntervalMs: number,
    private memoryWatcherEnabled: boolean
  ) {}

  setWebsocketRunning(running: boolean): void {
    this.wsRunning = running;
  }

  recordHeartbeat(): void {
    this.heartbeatLastRun = new Date();
  }

  recordMemoryWatcherRun(): void {
    this.memoryWatcherLastRun = new Date();
  }

  getStatus(): FileServerStatus {
    const clients = this.broadcastManager.getClients().map(c => ({
      id: c.id,
      type: c.type,
    }));

    return {
      websocket: {
        running: this.wsRunning,
        port: this.wsPort,
        clientCount: clients.length,
        clients,
      },
      heartbeat: {
        lastRunAt: this.heartbeatLastRun?.toISOString() ?? null,
        intervalMs: this.heartbeatIntervalMs,
      },
      memoryWatcher: {
        lastRunAt: this.memoryWatcherLastRun?.toISOString() ?? null,
        intervalMs: this.memoryWatcherIntervalMs,
        enabled: this.memoryWatcherEnabled,
      },
      session: {
        path: this.sessionPath,
      },
    };
  }
}
