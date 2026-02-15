import { WebSocketServer, WebSocket } from "ws";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { BroadcastManager } from "./broadcast.js";
import type { Client, WSClientMessage, WSServerMessage } from "./types-ws.js";
import { config } from "./config.js";
import { ImageStorage } from "./image-storage.js";

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

  constructor(
    private broadcastManager: BroadcastManager,
    private port: number = 3456
  ) {
    this.imageStorage = new ImageStorage();
  }

  async start(): Promise<void> {
    // Initialize image storage
    await this.imageStorage.init();

    return new Promise((resolve, reject) => {
      // Bind to localhost only for security
      this.wss = new WebSocketServer({
        port: this.port,
        host: "127.0.0.1"
      });

      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.wss.on("error", (err) => {
        console.error("[WebSocket] Server error:", err);
        reject(err);
      });

      this.wss.on("listening", () => {
        console.log(`[WebSocket] Server listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });

      // Start heartbeat to detect disconnected clients
      this.pingInterval = setInterval(() => this.heartbeat(), 30000);
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

  private handleConnection(ws: WebSocket): void {
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
            provider: stateMessage.data.provider,
          },
        });
      } else {
        client.send({
          type: "connection",
          data: { connected: true },
        });
      }
    } catch (err) {
      client.send({
        type: "connection",
        data: { connected: true },
      });
    }
  }

  private async handleMessage(client: WSClient, data: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    try {
      const dataStr = Buffer.isBuffer(data) ? data.toString() : Buffer.from(data as ArrayBuffer).toString();
      const message = JSON.parse(dataStr) as WSClientMessage;
      console.log(`[WebSocket] Received ${message.type} from ${client.id}`);

      switch (message.type) {
        case "prompt":
          await this.handlePrompt(client, message.message);
          break;

        case "prompt_with_images":
          await this.handlePromptWithImages(client, message.message, message.images);
          break;

        case "abort":
          this.broadcastManager.abort();
          break;

        case "get_state":
          await this.handleGetState(client);
          break;

        case "get_history":
          await this.handleGetHistory(client, message.limit ?? 50);
          break;

        case "command":
          await this.handleCommand(client, message.command, message.args);
          break;

        default:
          client.send({
            type: "error",
            data: { message: `Unknown message type: ${(message as {type: string}).type}` },
          });
      }
    } catch (err) {
      console.error("[WebSocket] Failed to parse message:", err);
      client.send({
        type: "error",
        data: { message: "Invalid JSON message" },
      });
    }
  }

  private async handlePrompt(client: WSClient, message: string): Promise<void> {
    try {
      const participatingClients = await this.broadcastManager.sendPrompt(message, client.id);
      
      // Confirm to sender that prompt was accepted
      client.send({
        type: "state",
        data: { isProcessing: true },
      });

      console.log(`[WebSocket] Prompt sent, ${participatingClients.size} clients will receive response`);
    } catch (err) {
      client.send({
        type: "error",
        data: { 
          message: err instanceof Error ? err.message : "Failed to send prompt" 
        },
      });
    }
  }

  private async handlePromptWithImages(
    client: WSClient,
    message: string,
    images: { data: string; mimeType: string }[]
  ): Promise<void> {
    try {
      // Validate images
      if (!images || images.length === 0) {
        client.send({
          type: "error",
          data: { message: "No images provided" },
        });
        return;
      }

      console.log(`[WebSocket] Received prompt_with_images with ${images.length} image(s):`);
      images.forEach((img, i) => {
        const decodedSize = (img.data.length * 3) / 4;
        console.log(`  Image ${i + 1}: ${img.mimeType}, ${decodedSize} bytes`);
      });

      // Check image sizes (5MB limit per image)
      const maxSize = 5 * 1024 * 1024; // 5MB in bytes
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        // Base64 is ~4/3 the size of binary, so check decoded size
        const decodedSize = (img.data.length * 3) / 4;
        if (decodedSize > maxSize) {
          client.send({
            type: "error",
            data: { message: `Image ${i + 1} exceeds 5MB limit` },
          });
          return;
        }
      }

      // Save images to disk and get file paths
      const imageRefs: { path: string; mimeType: string; data: string }[] = [];
      for (const img of images) {
        const stored = await this.imageStorage.saveImage(img.data, img.mimeType);
        imageRefs.push({
          path: stored.path,
          mimeType: stored.mimeType,
          data: img.data, // Keep base64 for sending to Pi
        });
      }

      const participatingClients = await this.broadcastManager.sendPromptWithImages(
        message,
        imageRefs, // Now includes path + base64
        client.id
      );
      
      // Confirm to sender that prompt was accepted
      client.send({
        type: "state",
        data: { isProcessing: true },
      });

      console.log(`[WebSocket] Prompt with ${images.length} image(s) sent, ${participatingClients.size} clients will receive response`);
    } catch (err) {
      client.send({
        type: "error",
        data: { 
          message: err instanceof Error ? err.message : "Failed to send prompt with images" 
        },
      });
    }
  }

  private async handleGetState(client: WSClient): Promise<void> {
    try {
      const state = await this.broadcastManager.getState();
      client.send(state);
    } catch (err) {
      client.send({
        type: "error",
        data: { message: "Failed to get state" },
      });
    }
  }

  private async handleCommand(
    client: WSClient, 
    command: string, 
    args?: string[]
  ): Promise<void> {
    console.log(`[WebSocket] Command received: ${command} ${args?.join(" ") || ""}`);
    
    try {
      let responseText: string;
      
      switch (command) {
        case "model":
          responseText = await this.broadcastManager.handleModelCommand(args?.[0] || "");
          break;
          
        case "session":
          responseText = await this.broadcastManager.handleSessionCommand();
          break;
          
        case "new":
          responseText = await this.broadcastManager.handleNewCommand();
          break;
          
        case "takeover":
          responseText = await this.broadcastManager.handleTakeoverCommand();
          break;
          
        default:
          responseText = `Unknown command: ${command}`;
      }
      
      // Send response as text delta followed by done
      client.send({
        type: "text_delta",
        data: { content: responseText },
      });
      
      client.send({
        type: "done",
        data: { finalText: responseText },
      });
      
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[WebSocket] Command failed: ${command}`, err);
      
      client.send({
        type: "error",
        data: { message: `Command failed: ${errorMsg}` },
      });
    }
  }

  private async handleGetHistory(client: WSClient, limit: number): Promise<void> {
    try {
      const messages = await this.readSessionHistory(limit);
      client.send({
        type: "history",
        data: { messages },
      });
    } catch (err) {
      console.error("[WebSocket] Failed to read history:", err);
      client.send({
        type: "history",
        data: { messages: [] },
      });
    }
  }

  private async readSessionHistory(limit: number): Promise<unknown[]> {
    const sessionPath = config.pi.sessionPath;
    const messages: unknown[] = [];

    try {
      const fileStream = createReadStream(sessionPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message") continue;

          const role = entry.message?.role;

          // Keep regular chat history, but sanitize images in content to use file paths
          if (role === "user" || role === "assistant") {
            const sanitizedContent = await this.imageStorage.sanitizeForHistory(
              entry.message.content
            );
            messages.push({
              id: entry.id,
              role,
              content: sanitizedContent,
              timestamp: entry.timestamp,
            });
            continue;
          }

          // For tool results, only keep lightweight image history items
          // to avoid oversized WebSocket history payloads.
          if (role === "toolResult") {
            const sanitizedImageContent = this.sanitizeToolResultImageContent(entry.message);
            if (sanitizedImageContent.length > 0) {
              messages.push({
                id: entry.id,
                role,
                content: sanitizedImageContent,
                timestamp: entry.timestamp,
                toolCallId: entry.message.toolCallId,
                toolName: entry.message.toolName,
                isError: entry.message.isError,
              });
            }
          }
        } catch {
          // Skip invalid lines
        }
      }

      // Return last N messages
      return messages.slice(-limit);
    } catch (err) {
      console.error("[WebSocket] Error reading session file:", err);
      return [];
    }
  }

  private sanitizeToolResultImageContent(message: { content?: unknown; details?: unknown }): unknown[] {
    const content = message.content;
    if (!Array.isArray(content)) return [];

    const details = (message.details && typeof message.details === "object") ? message.details as Record<string, unknown> : undefined;
    const detailsPath = typeof details?.path === "string"
      ? details.path
      : (typeof details?.savedPath === "string" ? details.savedPath : undefined);

    const imageItems: unknown[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "image") continue;

      // Prefer file path/url in history payloads (small).
      if (typeof p.path === "string") {
        imageItems.push({ type: "image", path: p.path });
        continue;
      }
      if (typeof p.url === "string") {
        imageItems.push({ type: "image", url: p.url });
        continue;
      }
      if (detailsPath) {
        imageItems.push({ type: "image", path: detailsPath });
        continue;
      }

      // Fallback to inline data only if reasonably small.
      const data = typeof p.data === "string" ? p.data : undefined;
      const mimeType = typeof p.mimeType === "string" ? p.mimeType : "image/png";
      if (data && data.length <= 120_000) {
        imageItems.push({ type: "image", data, mimeType });
      }
    }

    return imageItems;
  }

  private heartbeat(): void {
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
