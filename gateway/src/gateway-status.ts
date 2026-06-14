import { readFile } from "node:fs/promises";
import type { BroadcastManager } from "./broadcast.js";
import type { PiRpcClient } from "./pi-rpc.js";
import type { ApiServerStatus, StatusProvider } from "./status-types.js";

export class GatewayStatusProvider implements StatusProvider {
  private heartbeatLastRun: Date | null = null;
  private dailyContextLastRun: Date | null = null;
  private wsRunning = false;

  constructor(
    private broadcastManager: BroadcastManager,
    private pi: PiRpcClient,
    private sessionPath: string,
    private wsPort: number,
    private wsHost: string,
    private heartbeatIntervalMs: number
  ) {}

  setWebsocketRunning(running: boolean): void {
    this.wsRunning = running;
  }

  recordHeartbeat(): void {
    this.heartbeatLastRun = new Date();
  }

  recordDailyContextRun(): void {
    this.dailyContextLastRun = new Date();
  }

  async getStatus(): Promise<ApiServerStatus> {
    const clients = this.broadcastManager.getClients().map(c => ({
      id: c.id,
      type: c.type,
    }));

    // Fetch current model and context from Pi
    let model: ApiServerStatus["session"]["model"] | undefined;
    let contextTokens: number | undefined;
    try {
      const stateResponse = await this.pi.getState();
      const stateData = stateResponse.data as {
        model?: { id: string; provider: string; name: string; contextWindow?: number };
      } | undefined;
      if (stateData?.model) {
        model = {
          id: stateData.model.id,
          name: stateData.model.name,
          provider: stateData.model.provider,
          contextWindow: stateData.model.contextWindow,
        };
      }
      const tokens = await this.readContextTokensFromSession();
      contextTokens = tokens ?? undefined;
    } catch {
      // Pi not ready — omit model/context from status
    }

    return {
      websocket: {
        running: this.wsRunning,
        host: this.wsHost,
        port: this.wsPort,
        clientCount: clients.length,
        clients,
      },
      heartbeat: {
        lastRunAt: this.heartbeatLastRun?.toISOString() ?? null,
        intervalMs: this.heartbeatIntervalMs,
      },
      dailyContext: {
        lastRunAt: this.dailyContextLastRun?.toISOString() ?? null,
      },
      session: {
        path: this.sessionPath,
        model,
        contextTokens,
        contextWindow: model?.contextWindow,
      },
    };
  }

  private async readContextTokensFromSession(): Promise<number | null> {
    try {
      const content = await readFile(this.sessionPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) return null;
      const lines = trimmed.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
          const usage = entry.message.usage;
          return (usage.cacheRead ?? 0) + (usage.inputTokens ?? 0);
        }
      }
    } catch {
      // ignore
    }
    return null;
  }
}
