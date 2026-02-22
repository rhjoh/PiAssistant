import type { Client, WSClientMessage, WSServerMessage } from "../types-ws.js";
import type { BroadcastManager } from "../broadcast.js";
import type { ImageStorage } from "../image-storage.js";
import { CommandRegistry, type CommandContext } from "./commands.js";

export interface MessageHandler {
  canHandle(type: string): boolean;
  handle(client: Client, message: WSClientMessage): Promise<void>;
}

export class PromptHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "prompt";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "prompt") return;
    
    try {
      const participatingClients = await this.broadcastManager.sendPrompt(
        message.message,
        client.id
      );
      
      client.send({
        type: "state",
        data: { isProcessing: true },
      });

      console.log(`[WebSocket] Prompt sent, ${participatingClients.size} clients will receive response`);
    } catch (err) {
      client.send({
        type: "error",
        data: {
          message: err instanceof Error ? err.message : "Failed to send prompt",
        },
      });
    }
  }
}

export class PromptWithImagesHandler implements MessageHandler {
  private maxImageSize = 5 * 1024 * 1024; // 5MB

  constructor(
    private broadcastManager: BroadcastManager,
    private imageStorage: ImageStorage
  ) {}

  canHandle(type: string): boolean {
    return type === "prompt_with_images";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "prompt_with_images") return;
    
    try {
      const { message: text, images } = message;
      
      if (!images || images.length === 0) {
        client.send({
          type: "error",
          data: { message: "No images provided" },
        });
        return;
      }

      console.log(`[WebSocket] Received prompt_with_images with ${images.length} image(s):`);
      
      // Validate sizes
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const decodedSize = (img.data.length * 3) / 4;
        console.log(`  Image ${i + 1}: ${img.mimeType}, ${decodedSize} bytes`);
        
        if (decodedSize > this.maxImageSize) {
          client.send({
            type: "error",
            data: { message: `Image ${i + 1} exceeds 5MB limit` },
          });
          return;
        }
      }

      // Save images and get paths
      const imageRefs = await Promise.all(
        images.map(async (img) => {
          const stored = await this.imageStorage.saveImage(img.data, img.mimeType);
          return {
            path: stored.path,
            mimeType: stored.mimeType,
            data: img.data,
          };
        })
      );

      const participatingClients = await this.broadcastManager.sendPromptWithImages(
        text,
        imageRefs,
        client.id
      );

      client.send({
        type: "state",
        data: { isProcessing: true },
      });

      console.log(`[WebSocket] Prompt with ${images.length} image(s) sent, ${participatingClients.size} clients will receive response`);
    } catch (err) {
      client.send({
        type: "error",
        data: {
          message: err instanceof Error ? err.message : "Failed to send prompt with images",
        },
      });
    }
  }
}

export class AbortHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "abort";
  }

  async handle(_client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "abort") return;
    this.broadcastManager.abort();
  }
}

export class GetStateHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "get_state";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "get_state") return;
    
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
}

export class GetHistoryHandler implements MessageHandler {
  constructor(
    private imageStorage: ImageStorage,
    private sessionPath: string
  ) {}

  canHandle(type: string): boolean {
    return type === "get_history";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "get_history") return;
    
    try {
      const limit = message.limit ?? 50;
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
    const { existsSync } = await import("node:fs");
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");

    const messages: unknown[] = [];

    if (!existsSync(this.sessionPath)) {
      return messages;
    }

    try {
      const fileStream = createReadStream(this.sessionPath);
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

          if (role === "toolResult") {
            const sanitizedContent = await this.imageStorage.sanitizeForHistory(
              entry.message.content
            );
            messages.push({
              id: entry.id,
              role,
              content: sanitizedContent,
              timestamp: entry.timestamp,
              toolCallId: entry.message.toolCallId,
              toolName: entry.message.toolName,
              isError: entry.message.isError,
            });
          }
        } catch {
          // Skip invalid lines
        }
      }

      return messages.slice(-limit);
    } catch (err) {
      console.error("[WebSocket] Error reading session file:", err);
      return [];
    }
  }
}

export class CommandHandler implements MessageHandler {
  private registry: CommandRegistry;

  constructor(ctx: CommandContext) {
    this.registry = new CommandRegistry(ctx);
  }

  canHandle(type: string): boolean {
    return type === "command";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "command") return;
    
    const { command, args = [] } = message;
    console.log(`[WebSocket] Command received: ${command} ${args?.join(" ") || ""}`);

    try {
      const responseText = await this.registry.execute(command, args);

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
}

export class MessageRouter {
  private handlers: MessageHandler[] = [];

  constructor(handlers: MessageHandler[]) {
    this.handlers = handlers;
  }

  async route(client: Client, message: WSClientMessage): Promise<void> {
    const handler = this.handlers.find((h) => h.canHandle(message.type));

    if (!handler) {
      client.send({
        type: "error",
        data: { message: `Unknown message type: ${message.type}` },
      });
      return;
    }

    await handler.handle(client, message);
  }
}
