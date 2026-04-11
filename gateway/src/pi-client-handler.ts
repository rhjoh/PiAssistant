import { WebSocket } from "ws";
import type { BroadcastManager } from "./broadcast.js";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent } from "./types.js";
import type { PiClientNativeEvent as PiNativeEvent } from "./types-ws.js";

/**
 * Messages from Pi TUI → Gateway
 */
export type PiClientMessage =
  | { type: "prompt"; messages: Array<{ role: string; content: string }>; sessionId?: string }
  | { type: "abort" }
  | { type: "get_history"; limit?: number }
  | { type: "ping" };

interface PiClientConnection {
  id: string;
  ws: WebSocket;
  isAlive: boolean;
  currentTurnId: string | null;
  seq: number;
  sawToolInTurn: boolean;
}

/**
 * PiClientHandler manages WebSocket connections from Pi bridge clients.
 *
 * Critical behavior: /pi-client now receives a direct Pi-native event contract
 * from Pi RPC events, not re-translated generic broadcast events.
 */
export class PiClientHandler {
  private clients = new Map<WebSocket, PiClientConnection>();

  constructor(
    private broadcastManager: BroadcastManager,
    private pi: PiRpcClient,
  ) {
    this.setupPiListeners();
  }

  /**
   * Handle a new WebSocket connection from Pi TUI
   */
  handleConnection(ws: WebSocket): void {
    const clientId = `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const client: PiClientConnection = {
      id: clientId,
      ws,
      isAlive: true,
      currentTurnId: null,
      seq: 0,
      sawToolInTurn: false,
    };

    this.clients.set(ws, client);

    console.log(`[PiClient] Pi TUI connected: ${clientId}`);
    this.sendConnectionConfirmation(client);

    ws.on("message", (data) => this.handleMessage(client, data));

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("close", () => {
      console.log(`[PiClient] Pi TUI disconnected: ${clientId}`);
      this.clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error(`[PiClient] Pi TUI error (${clientId}):`, err);
    });
  }

  /**
   * Check if any Pi clients are connected
   */
  hasConnectedClients(): boolean {
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /**
   * Perform heartbeat check on all connections
   */
  heartbeat(): void {
    for (const [ws, client] of this.clients) {
      if (!client.isAlive) {
        console.log(`[PiClient] Terminating dead connection: ${client.id}`);
        ws.terminate();
        this.clients.delete(ws);
        continue;
      }

      client.isAlive = false;
      ws.ping();
    }
  }

  private nextSeq(client: PiClientConnection): number {
    client.seq += 1;
    return client.seq;
  }

  private ensureTurn(client: PiClientConnection): string {
    if (!client.currentTurnId) {
      client.currentTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      client.seq = 0;
      client.sawToolInTurn = false;
      this.sendNative(client, {
        type: "turn_start",
        turnId: client.currentTurnId,
        seq: this.nextSeq(client),
      });
    }
    return client.currentTurnId;
  }

  private endTurn(
    client: PiClientConnection,
    stopReason: "stop" | "toolUse" | "error" | "aborted",
  ): void {
    if (!client.currentTurnId) return;
    const turnId = client.currentTurnId;
    this.sendNative(client, {
      type: "turn_end",
      turnId,
      seq: this.nextSeq(client),
      stopReason,
    });
    client.currentTurnId = null;
    client.seq = 0;
    client.sawToolInTurn = false;
  }

  private sendNative(client: PiClientConnection, event: PiNativeEvent): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(JSON.stringify(event));
  }

  private broadcastNative(build: (client: PiClientConnection) => PiNativeEvent | null): void {
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const event = build(client);
      if (event) {
        this.sendNative(client, event);
      }
    }
  }

  private async sendConnectionConfirmation(client: PiClientConnection): Promise<void> {
    console.log(`[PiClient] Connection confirmed for ${client.id}`);
  }

  private async handleMessage(
    client: PiClientConnection,
    data: Buffer | ArrayBuffer | Buffer[],
  ): Promise<void> {
    try {
      const dataStr = Buffer.isBuffer(data)
        ? data.toString()
        : Buffer.from(data as ArrayBuffer).toString();
      const message = JSON.parse(dataStr) as PiClientMessage;

      console.log(`[PiClient] Received ${message.type} from ${client.id}`);

      switch (message.type) {
        case "prompt":
          await this.handlePrompt(client, message.messages);
          break;

        case "abort":
          this.pi.abort();
          this.endTurn(client, "aborted");
          break;

        case "get_history":
          await this.handleGetHistory(client, message.limit ?? 50);
          break;

        case "ping":
          break;

        default:
          this.sendError(client, `Unknown message type: ${(message as { type: string }).type}`);
      }
    } catch (err) {
      console.error("[PiClient] Failed to parse message:", err);
      this.sendError(client, "Invalid JSON message");
    }
  }

  private async handlePrompt(
    client: PiClientConnection,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    try {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMessage) {
        this.sendError(client, "No user message found in prompt");
        return;
      }

      this.ensureTurn(client);

      // Keep unified gateway behavior for all clients while Pi-native clients
      // receive direct Pi events via setupPiListeners().
      await this.broadcastManager.sendPrompt(lastUserMessage.content, client.id);
    } catch (err) {
      console.error("[PiClient] Failed to send prompt:", err);
      this.sendError(client, err instanceof Error ? err.message : "Failed to send prompt");
    }
  }

  private async handleGetHistory(client: PiClientConnection, _limit: number): Promise<void> {
    try {
      const turnId = this.ensureTurn(client);
      this.sendNative(client, {
        type: "text_done",
        turnId,
        seq: this.nextSeq(client),
        text: "History sync not yet implemented",
      });
      this.endTurn(client, "stop");
    } catch (err) {
      console.error("[PiClient] Failed to get history:", err);
      this.sendError(client, "Failed to get history");
    }
  }

  private sendError(client: PiClientConnection, message: string): void {
    const turnId = this.ensureTurn(client);
    this.sendNative(client, {
      type: "error",
      turnId,
      seq: this.nextSeq(client),
      message,
    });
    this.endTurn(client, "error");
  }

  private setupPiListeners(): void {
    this.pi.on("event", (event: PiEvent) => {
      if (this.clients.size === 0) return;
      if (this.pi.promptSource !== "user") return;

      switch (event.type) {
        case "message_update": {
          const msg = event.assistantMessageEvent;
          if (msg.type === "text_delta") {
            this.broadcastNative((client) => {
              const turnId = this.ensureTurn(client);
              return {
                type: "text_delta",
                turnId,
                seq: this.nextSeq(client),
                text: msg.delta,
              };
            });
          } else if (msg.type === "text_done") {
            this.broadcastNative((client) => {
              const turnId = this.ensureTurn(client);
              return {
                type: "text_done",
                turnId,
                seq: this.nextSeq(client),
                text: msg.text,
              };
            });
          } else if (msg.type === "thinking_delta") {
            this.broadcastNative((client) => {
              const turnId = this.ensureTurn(client);
              return {
                type: "thinking",
                turnId,
                seq: this.nextSeq(client),
                text: msg.delta,
              };
            });
          } else if (msg.type === "thinking_done") {
            this.broadcastNative((client) => {
              const turnId = this.ensureTurn(client);
              return {
                type: "thinking_done",
                turnId,
                seq: this.nextSeq(client),
              };
            });
          }
          break;
        }

        case "tool_execution_start": {
          this.broadcastNative((client) => {
            const turnId = this.ensureTurn(client);
            client.sawToolInTurn = true;
            return {
              type: "tool_execution_start",
              turnId,
              seq: this.nextSeq(client),
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: this.asRecord(event.args),
            };
          });
          break;
        }

        case "tool_execution_update": {
          this.broadcastNative((client) => {
            const turnId = this.ensureTurn(client);
            return {
              type: "tool_execution_update",
              turnId,
              seq: this.nextSeq(client),
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: this.asRecord(event.args),
              partialResult: event.partialResult,
            };
          });
          break;
        }

        case "tool_execution_end": {
          this.broadcastNative((client) => {
            const turnId = this.ensureTurn(client);
            return {
              type: "tool_execution_end",
              turnId,
              seq: this.nextSeq(client),
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              args: this.asRecord(event.args),
            };
          });

          const images = this.extractImagesFromToolResult(event.result);
          for (const image of images) {
            this.broadcastNative((client) => {
              const turnId = this.ensureTurn(client);
              return {
                type: "image",
                turnId,
                seq: this.nextSeq(client),
                data: image.data,
                mimeType: image.mimeType,
              };
            });
          }
          break;
        }

        case "agent_end": {
          for (const client of this.clients.values()) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            const turnId = this.ensureTurn(client);
            this.sendNative(client, {
              type: "done",
              turnId,
              seq: this.nextSeq(client),
            });
            this.endTurn(client, client.sawToolInTurn ? "toolUse" : "stop");
          }
          break;
        }

        default:
          break;
      }
    });

    this.pi.on("error", (err) => {
      for (const client of this.clients.values()) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        const turnId = this.ensureTurn(client);
        this.sendNative(client, {
          type: "error",
          turnId,
          seq: this.nextSeq(client),
          message: err.message || "Pi RPC error",
        });
        this.endTurn(client, "error");
      }
    });
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private extractImagesFromToolResult(result: unknown): Array<{ data: string; mimeType: string }> {
    if (!result || typeof result !== "object") return [];
    const r = result as Record<string, unknown>;
    const content = r.content;
    if (!Array.isArray(content)) return [];

    const images: Array<{ data: string; mimeType: string }> = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type !== "image") continue;
      const data = typeof part.data === "string" ? part.data : null;
      if (!data) continue;
      images.push({
        data,
        mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
      });
    }
    return images;
  }
}
