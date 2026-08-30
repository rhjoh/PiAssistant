import type { Client, WSClientMessage } from "../types-ws.js";
import { isThinkingLevel, type BroadcastManager } from "../broadcast.js";
import type { ImageStorage } from "../image-storage.js";
import { CommandRegistry, type CommandContext } from "./commands.js";
import { toolLabelForCallId } from "../tool-call-cache.js";

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
      await this.broadcastManager.sendPrompt(
        message.message,
        client.id,
        message.id,
        message.streamingBehavior
      );

      client.send({
        type: "state",
        data: this.broadcastManager.snapshotState(),
      });

      // Prompt start is logged once by BroadcastManager — see broadcast.ts
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
        client.id,
        message.id,
        message.streamingBehavior
      );

      client.send({
        type: "state",
        data: this.broadcastManager.snapshotState(),
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
    // Await the full escalation (grace period -> force-clear -> Pi restart)
    // so the client's abort request reliably unsticks the session.
    await this.broadcastManager.abort();
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
              usage: role === "assistant" ? this.normalizeUsage(entry.message.usage) : undefined,
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
              // The session file doesn't persist tool arguments; reuse the
              // label this gateway computed when the call ran (if it did).
              label: toolLabelForCallId(entry.message.toolCallId),
              isError: entry.message.isError,
            });
          }
        } catch {
          // Skip invalid lines
        }
      }

      // Non-positive limits explicitly request the complete session history.
      return limit > 0 ? messages.slice(-limit) : messages;
    } catch (err) {
      console.error("[WebSocket] Error reading session file:", err);
      return [];
    }
  }

  private normalizeUsage(usage: unknown): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost?: number;
  } | undefined {
    if (!usage || typeof usage !== "object") return undefined;

    const u = usage as {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
      totalTokens?: number;
      cost?: number | { total?: number };
    };

    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    const total =
      u.total ?? u.totalTokens ?? input + output + cacheRead + cacheWrite;
    const cost = typeof u.cost === "number" ? u.cost : u.cost?.total;

    return { input, output, cacheRead, cacheWrite, total, cost };
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
    console.log(`[WebSocket] Command received: ${command} (args=${args.length})`);

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

export class PingHandler implements MessageHandler {
  canHandle(type: string): boolean {
    return type === "ping";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "ping") return;

    const latencyMs =
      typeof message.timestamp === "number" ? Math.max(0, Date.now() - message.timestamp) : null;
    // Ping logging suppressed — too noisy for the log file.
    // Use personalos status or the Web UI debug panel for connection diagnostics.

    client.send({
      type: "pong",
      data: { timestamp: message.timestamp || Date.now() },
    });
  }
}

export class GetModelsHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "get_models";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "get_models") return;

    try {
      const models = await this.broadcastManager.getAvailableModels();
      const state = await this.broadcastManager.getState();
      // state.data.model is now a WSModelInfo object { id, provider, name }
      const currentModel = state.data.model;
      
      client.send({
        type: "models",
        data: {
          models,
          current: currentModel,
        },
      });
    } catch (err) {
      console.error("[WebSocket] Failed to get models:", err);
      client.send({
        type: "models",
        data: { models: [] },
      });
    }
  }
}

export class SwitchModelHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "switch_model";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "switch_model") return;

    const { provider, modelId } = message;

    try {
      const result = await this.broadcastManager.switchModel(provider, modelId);

      // On success, switchModel() already broadcast model_switched to all clients.
      // Only send error response directly to the requesting client.
      if (!result.success) {
        client.send({
          type: "model_switched",
          data: result,
        });
      }
    } catch (err) {
      console.error("[WebSocket] Failed to switch model:", err);
      client.send({
        type: "model_switched",
        data: {
          success: false,
          error: err instanceof Error ? err.message : "Failed to switch model",
        },
      });
    }
  }
}

export class GetThinkingLevelsHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "get_thinking_levels";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "get_thinking_levels") return;
    try {
      const data = await this.broadcastManager.getThinkingLevels();
      client.send({ type: "thinking_levels", data });
    } catch (err) {
      client.send({
        type: "error",
        data: {
          message: err instanceof Error ? err.message : "Failed to get thinking levels",
        },
      });
    }
  }
}

export class SetThinkingLevelHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "set_thinking_level";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "set_thinking_level") return;
    if (!isThinkingLevel(message.level)) {
      client.send({
        type: "error",
        data: { message: "Invalid thinking level" },
      });
      return;
    }

    const result = await this.broadcastManager.setThinkingLevel(message.level);
    client.send({ type: "thinking_level_changed", data: result });
  }
}

export class ExtensionUiResponseHandler implements MessageHandler {
  constructor(private broadcastManager: BroadcastManager) {}

  canHandle(type: string): boolean {
    return type === "extension_ui_response";
  }

  async handle(client: Client, message: WSClientMessage): Promise<void> {
    if (message.type !== "extension_ui_response") return;
    await this.broadcastManager.submitExtensionUiResponse(message, client.id);
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
      const supported = this.handlers
        .map((h) => {
          // Best-effort derive known type labels from handler class names for logging.
          const name = h.constructor?.name ?? "handler";
          return name;
        })
        .join(", ");
      console.warn(
        `[WebSocket] Unknown message type from ${client.id}: ${(message as { type?: string }).type} | handlers=${supported}`
      );
      client.send({
        type: "error",
        data: { message: `Unknown message type: ${message.type}` },
      });
      return;
    }

    await handler.handle(client, message);
  }
}
