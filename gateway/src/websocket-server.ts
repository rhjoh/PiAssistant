import { WebSocketServer, WebSocket } from "ws";
import type { BroadcastManager } from "./broadcast.js";
import type { Client, WSClientMessage, WSServerMessage } from "./types-ws.js";
import { config } from "./config.js";
import { ImageStorage } from "./image-storage.js";
import type { PiRpcClient } from "./pi-rpc.js";
import {
  MessageRouter,
  PromptHandler,
  PromptWithImagesHandler,
  AbortHandler,
  GetStateHandler,
  GetHistoryHandler,
  CommandHandler,
  PingHandler,
  ToolCallHandler,
  ToolResultHandler,
  GetModelsHandler,
  SwitchModelHandler,
} from "./handlers/messages.js";

interface WSClient extends Client {
  ws: WebSocket;
  isAlive: boolean;
}

/**
 * WebSocket server for multi-client access to Pi.
 *
 * All clients connect here and receive the same broadcasts.
 * Telegram is treated as another client via BroadcastManager.
 */
export class WebSocketGateway {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, WSClient>();
  private pingInterval: NodeJS.Timeout | null = null;
  private imageStorage: ImageStorage;
  private messageRouter: MessageRouter;

  constructor(
    private broadcastManager: BroadcastManager,
    private pi: PiRpcClient,
    private port: number = 3456
  ) {
    this.imageStorage = new ImageStorage(config.images.dir);

    // Initialize message router with handlers
    this.messageRouter = new MessageRouter([
      new PromptHandler(broadcastManager),
      new PromptWithImagesHandler(broadcastManager, this.imageStorage),
      new AbortHandler(broadcastManager),
      new GetStateHandler(broadcastManager),
      new GetHistoryHandler(this.imageStorage, config.pi.sessionPath),
      new CommandHandler({ broadcastManager }),
      new ToolCallHandler(broadcastManager),
      new ToolResultHandler(broadcastManager),
      new PingHandler(),
      new GetModelsHandler(broadcastManager),
      new SwitchModelHandler(broadcastManager),
    ]);
  }

  async start(): Promise<void> {
    // Initialize image storage
    await this.imageStorage.init();

    return new Promise((resolve, reject) => {
      // Bind to localhost only for security
      this.wss = new WebSocketServer({
        port: this.port,
        host: "127.0.0.1",
        // Avoid Bun + ws permessage-deflate CPU spikes.
        perMessageDeflate: false,
      });

      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
      this.wss.on("error", (err) => {
        console.error("[WebSocket] Server error:", err);
        reject(err);
      });

      this.wss.on("listening", () => {
        console.log(`[WebSocket] Server listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });

      // Start heartbeat to detect disconnected clients
      const heartbeatInterval = config.heartbeat.intervalMs;
      this.pingInterval = setInterval(() => this.heartbeat(), heartbeatInterval);
      console.log(`[WebSocket] Heartbeat interval: ${heartbeatInterval}ms`);
    });
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Close all client connections
    for (const [ws, client] of this.clients) {
      this.broadcastManager.unregisterClient(client.id);
      ws.terminate();
    }
    this.clients.clear();

    // Close server
    this.wss?.close();
    this.wss = null;
    console.log("[WebSocket] Server stopped");
  }

  private handleConnection(ws: WebSocket, _req: { url?: string }): void {
    // Regular client connection
    const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const client: WSClient = {
      id: clientId,
      type: "websocket",
      ws,
      isAlive: true,
      send: async (message: WSServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
        }
      },
      isAvailable: () => ws.readyState === WebSocket.OPEN,
    };

    this.clients.set(ws, client);
    this.broadcastManager.registerClient(client);

    console.log(`[WebSocket] Client connected: ${clientId}`);

    // Send connection confirmation with current state
    this.sendConnectionConfirmation(client);

    // Handle messages
    ws.on("message", (data) => this.handleMessage(client, data));

    // Handle pong (heartbeat response)
    ws.on("pong", () => {
      client.isAlive = true;
    });

    // Handle close
    ws.on("close", () => {
      console.log(`[WebSocket] Client disconnected: ${clientId}`);
      this.clients.delete(ws);
      this.broadcastManager.unregisterClient(clientId);
    });

    // Handle errors
    ws.on("error", (err) => {
      console.error(`[WebSocket] Client error (${clientId}):`, err);
    });
  }

  private async sendConnectionConfirmation(client: WSClient): Promise<void> {
    try {
      const stateMessage = await this.broadcastManager.getState();

      if (stateMessage.type === "state") {
        client.send({
          type: "connection",
          data: {
            connected: true,
            model: stateMessage.data.model,
            contextWindow: stateMessage.data.contextWindow,
          },
        });
      } else {
        client.send({
          type: "connection",
          data: { connected: true },
        });
      }
    } catch {
      client.send({
        type: "connection",
        data: { connected: true },
      });
    }
  }

  private async handleMessage(client: WSClient, data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    try {
      const dataStr = Buffer.isBuffer(data)
        ? data.toString()
        : Buffer.from(data as ArrayBuffer).toString();
      const message = JSON.parse(dataStr) as WSClientMessage;
      if (message.type !== "ping") {
        console.log(`[WebSocket] Received ${message.type} from ${client.id}`);
      }

      await this.messageRouter.route(client, message);
    } catch (err) {
      console.error("[WebSocket] Failed to parse message:", err);
      client.send({
        type: "error",
        data: { message: "Invalid JSON message" },
      });
    }
  }

  private heartbeat(): void {
    // Heartbeat regular clients
    for (const [ws, client] of this.clients) {
      if (!client.isAlive) {
        console.log(`[WebSocket] Terminating dead connection: ${client.id}`);
        ws.terminate();
        this.clients.delete(ws);
        this.broadcastManager.unregisterClient(client.id);
        continue;
      }

      client.isAlive = false;
      ws.ping();
    }
  }
}
