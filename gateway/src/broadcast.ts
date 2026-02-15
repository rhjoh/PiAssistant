import type { EventEmitter } from "node:events";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent } from "./types.js";
import type { Client, WSServerMessage } from "./types-ws.js";
import type { SessionManager } from "./session-manager.js";

/**
 * BroadcastManager handles multi-client message distribution.
 * 
 * Architecture:
 * - Pi RPC emits events (tool_start, text_delta, etc.)
 * - BroadcastManager receives events and forwards to all connected clients
 * - Telegram and WebSocket clients are treated equally
 * 
 * This allows multiple clients to see the same conversation simultaneously.
 */
export class BroadcastManager {
  private clients = new Map<string, Client>();
  private currentPrompt: { message: string; clientIds: Set<string> } | null = null;
  private sessionManager: SessionManager | null = null;

  constructor(private pi: PiRpcClient) {
    this.setupPiListeners();
  }

  /**
   * Set the session manager for handling /new commands
   */
  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  /**
   * Register a client to receive broadcast messages
   */
  registerClient(client: Client): void {
    this.clients.set(client.id, client);
    console.log(`[Broadcast] Client registered: ${client.type} (${client.id})`);
  }

  /**
   * Unregister a client
   */
  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    console.log(`[Broadcast] Client unregistered: ${clientId}`);
  }

  /**
   * Get all registered clients
   */
  getClients(): Client[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get count of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Send a prompt to Pi and broadcast to all clients
   * Returns the clients that will receive this response
   */
  async sendPrompt(message: string, originatingClientId: string): Promise<Set<string>> {
    // Track which clients are participating in this prompt
    const clientIds = new Set(this.clients.keys());
    this.currentPrompt = { message, clientIds };

    // Send prompt to Pi (this starts the streaming)
    // Note: We don't await here - Pi runs asynchronously and emits events
    this.pi.prompt(message).catch((err) => {
      console.error("[Broadcast] Pi prompt error:", err);
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : "Unknown error" },
      });
    });

    return clientIds;
  }

  /**
   * Send a prompt with images to Pi and broadcast to all clients
   * Returns the clients that will receive this response
   */
  async sendPromptWithImages(
    message: string,
    images: { data: string; mimeType: string; path?: string }[],
    originatingClientId: string
  ): Promise<Set<string>> {
    // Track which clients are participating in this prompt
    const clientIds = new Set(this.clients.keys());
    this.currentPrompt = { message, clientIds };

    console.log(`[Broadcast] Sending prompt with ${images.length} image(s) to Pi`);

    // Send prompt with images to Pi (this starts the streaming)
    // Note: We don't await here - Pi runs asynchronously and emits events
    // Strip paths before sending to Pi (Pi only needs base64)
    const piImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
    this.pi.promptWithImages(message, piImages).catch((err) => {
      console.error("[Broadcast] Pi promptWithImages error:", err);
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : "Unknown error" },
      });
    });

    return clientIds;
  }

  /**
   * Broadcast a message to all connected clients
   */
  async broadcast(message: WSServerMessage, excludeClientId?: string): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [id, client] of this.clients) {
      if (excludeClientId && id === excludeClientId) continue;
      if (!client.isAvailable()) continue;

      const result = client.send(message);
      if (result instanceof Promise) {
        promises.push(result.catch((err) => {
          console.error(`[Broadcast] Failed to send to ${id}:`, err);
        }));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Get current Pi state for new connections
   */
  async getState(): Promise<WSServerMessage> {
    try {
      const [stateResponse, statsResponse] = await Promise.all([
        this.pi.getState(),
        this.pi.getSessionStats().catch((err) => {
          console.log("[Broadcast] getSessionStats failed:", err);
          return null;
        }),
      ]);
      
      console.log("[Broadcast] getState response:", JSON.stringify(stateResponse.data, null, 2));
      console.log("[Broadcast] getSessionStats response:", JSON.stringify(statsResponse?.data, null, 2));
      
      const stateData = stateResponse.data as { 
        model?: { id: string; provider: string };
        messageCount?: number;
      } | undefined;
      
      const statsData = statsResponse?.data as { 
        tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      } | undefined;

      console.log("[Broadcast] contextTokens from stats:", statsData?.tokens?.cacheRead);

      return {
        type: "state",
        data: {
          model: stateData?.model?.id,
          provider: stateData?.model?.provider,
          contextTokens: statsData?.tokens?.cacheRead,
          isProcessing: false,
        },
      };
    } catch (err) {
      console.error("[Broadcast] getState failed:", err);
      return {
        type: "state",
        data: {
          isProcessing: false,
        },
      };
    }
  }

  /**
   * Abort current Pi operation
   */
  abort(): void {
    this.pi.abort();
  }

  private setupPiListeners(): void {
    // Track accumulated text for final response
    let currentText = "";
    let proseStartOffset = 0;
    let insideTool = false;
    let currentThinking = "";
    let isThinking = false;

    this.pi.on("event", (event: PiEvent) => {
      // Handle tool execution events
      if (event.type === "tool_execution_start") {
        insideTool = true;
        
        const label = this.formatToolLabel(event.toolName || "tool", event.args);
        
        this.broadcast({
          type: "tool_start",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            args: event.args,
            label,
          },
        });
      }

      if (event.type === "tool_execution_end") {
        // Mark prose offset
        proseStartOffset = currentText.length;
        
        const result = "result" in event ? (event as Record<string, unknown>).result : null;

        const images = this.extractImagesFromToolResult(result);
        for (const image of images) {
          this.broadcast({
            type: "image",
            data: {
              source: image.source,
              alt: image.alt,
            },
          });
        }

        const outputText = this.extractToolResultText(result);
        const truncated = this.truncateToolOutput(outputText);

        this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: truncated.text,
            truncated: truncated.wasTruncated,
          },
        });

        this.broadcast({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
          },
        });

        insideTool = false;
      }

      // Handle text streaming and thinking
      if (event.type === "message_update") {
        const msgEvent = event.assistantMessageEvent;

        if (msgEvent.type === "text_delta") {
          currentText += msgEvent.delta;

          // Only broadcast prose deltas (not tool output)
          if (!insideTool) {
            console.log(`[Broadcast] text_delta: "${msgEvent.delta.slice(0, 50)}${msgEvent.delta.length > 50 ? "..." : ""}"`);
            this.broadcast({
              type: "text_delta",
              data: { content: msgEvent.delta },
            });
          }
        }

        if (msgEvent.type === "text_done") {
          // Important: Use Pi's finalized text (can include corrected spacing/token joins)
          currentText = msgEvent.text;
        }

        if (msgEvent.type === "thinking_delta") {
          currentThinking += msgEvent.delta;
          isThinking = true;
          this.broadcast({
            type: "thinking_delta",
            data: { content: msgEvent.delta },
          });
        }

        if (msgEvent.type === "thinking_done") {
          isThinking = false;
          this.broadcast({
            type: "thinking_done",
            data: { content: currentThinking },
          });
          currentThinking = "";
        }
      }

      // Handle completion
      if (event.type === "agent_end") {
        const proseResponse = proseStartOffset > 0 
          ? currentText.slice(proseStartOffset) 
          : currentText;

        const imageExtractions = this.extractMarkdownImages(proseResponse);
        for (const image of imageExtractions.images) {
          this.broadcast({
            type: "image",
            data: {
              source: image.source,
              alt: image.alt,
            },
          });
        }

        // Extract token usage from the last assistant message
        const messages = (event as { messages?: unknown[] }).messages;
        const usage = this.extractTokenUsage(messages);

        console.log(`[Broadcast] done: ${imageExtractions.textOnly.slice(0, 100)}${imageExtractions.textOnly.length > 100 ? '...' : ''}`);
        this.broadcast({
          type: "done",
          data: { finalText: imageExtractions.textOnly, usage },
        });

        // Reset state for next prompt
        currentText = "";
        proseStartOffset = 0;
        insideTool = false;
        this.currentPrompt = null;
      }
    });
  }

  private formatToolLabel(toolName: string, args: unknown): string {
    const extractCommand = (value: unknown): string | null => {
      if (typeof value !== "object" || value === null) return null;
      const cmd = (value as Record<string, unknown>).command;
      return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
    };

    if (toolName === "bash") {
      const cmd = extractCommand(args);
      return cmd ? `$ ${cmd}` : "bash";
    }

    if (typeof args !== "object" || args === null) return toolName;
    const a = args as Record<string, unknown>;

    const pathLike =
      (typeof a.path === "string" && a.path) ||
      (typeof a.filePath === "string" && a.filePath) ||
      (typeof a.filename === "string" && a.filename);
    if (pathLike) return `${toolName} ${pathLike}`;

    const patternLike =
      (typeof a.pattern === "string" && a.pattern) ||
      (typeof a.glob === "string" && a.glob);
    if (patternLike) return `${toolName} ${patternLike}`;

    const urlLike = typeof a.url === "string" && a.url ? a.url : null;
    if (urlLike) return `${toolName} ${urlLike}`;

    const queryLike = typeof a.query === "string" && a.query ? a.query : null;
    if (queryLike) return `${toolName} ${queryLike}`;

    try {
      const json = JSON.stringify(args);
      const max = 140;
      return `${toolName} ${json.length > max ? json.slice(0, max - 1) + "…" : json}`;
    } catch {
      return toolName;
    }
  }

  private extractToolResultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (result === null || result === undefined) return "";
    if (Array.isArray(result)) {
      if (result.every((x) => typeof x === "string")) return (result as string[]).join("\n");
      return JSON.stringify(result, null, 2);
    }
    if (typeof result === "object") {
      const r = result as Record<string, unknown>;

      if (typeof r.text === "string") return r.text;
      if (typeof r.output === "string") return r.output;
      if (typeof r.stdout === "string") {
        let out = r.stdout;
        if (typeof r.stderr === "string" && r.stderr) out += "\n" + r.stderr;
        return out;
      }
      if (Array.isArray(r.paths) && r.paths.every((x) => typeof x === "string")) {
        return (r.paths as string[]).join("\n");
      }
      if (Array.isArray(r.matches) && r.matches.every((x) => typeof x === "string")) {
        return (r.matches as string[]).join("\n");
      }
      if (Array.isArray(r.content)) {
        const textParts = r.content
          .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : null))
          .filter((value): value is string => typeof value === "string");
        if (textParts.length > 0) return textParts.join("\n");
      }

      return JSON.stringify(result, null, 2);
    }
    return String(result);
  }

  private truncateToolOutput(text: string): { text: string; wasTruncated: boolean } {
    const maxChars = 1800;
    const maxLines = 30;
    
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return { text: "", wasTruncated: false };

    let out = normalized;
    let wasTruncated = false;

    const lines = normalized.split("\n");
    if (lines.length > maxLines) {
      out = lines.slice(0, maxLines).join("\n") + "\n… (truncated)";
      wasTruncated = true;
    }

    if (out.length > maxChars) {
      const truncated = out.slice(0, maxChars);
      const lastNewline = truncated.lastIndexOf("\n");
      const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
      out = out.slice(0, cutPoint) + "\n… (truncated)";
      wasTruncated = true;
    }

    return { text: out, wasTruncated };
  }

  private extractImagesFromToolResult(result: unknown): Array<{ source: string; alt?: string }> {
    if (!result || typeof result !== "object") return [];
    const r = result as Record<string, unknown>;
    const content = r.content;
    if (!Array.isArray(content)) return [];

    const images: Array<{ source: string; alt?: string }> = [];

    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type !== "image") continue;

      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      const base64 = typeof part.data === "string" ? part.data : null;
      if (base64 && base64.length > 0) {
        images.push({
          source: `data:${mimeType};base64,${base64}`,
          alt: "Generated image",
        });
      }
    }

    return images;
  }

  private extractMarkdownImages(text: string): { textOnly: string; images: Array<{ source: string; alt?: string }> } {
    const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const images: Array<{ source: string; alt?: string }> = [];

    const textOnly = text.replace(regex, (_, alt: string, source: string) => {
      const cleanSource = source.trim();
      if (cleanSource) {
        images.push({
          source: cleanSource,
          alt: alt?.trim() || undefined,
        });
      }
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();

    return { textOnly, images };
  }

  private extractTokenUsage(messages: unknown[] | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number } | undefined {
    // Truncate thinkingSignature for logging to avoid huge log lines
    const truncatedMessages = messages?.map((msg: unknown) => {
      if (typeof msg === "object" && msg !== null) {
        const m = msg as Record<string, unknown>;
        if (typeof m.thinkingSignature === "string" && m.thinkingSignature.length > 20) {
          return { ...m, thinkingSignature: m.thinkingSignature.slice(0, 10) + "..." };
        }
        // Also truncate inside content items
        if (Array.isArray(m.content)) {
          const truncatedContent = m.content.map((item: unknown) => {
            if (typeof item === "object" && item !== null) {
              const it = item as Record<string, unknown>;
              if (typeof it.thinkingSignature === "string" && it.thinkingSignature.length > 20) {
                return { ...it, thinkingSignature: it.thinkingSignature.slice(0, 10) + "..." };
              }
            }
            return item;
          });
          return { ...m, content: truncatedContent };
        }
      }
      return msg;
    });
    console.log("[Broadcast] Extracting token usage from messages:", JSON.stringify(truncatedMessages, null, 2));
    if (!messages || !Array.isArray(messages)) {
      console.log("[Broadcast] No messages array found");
      return undefined;
    }
    
    // Find the last assistant message with usage data
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
      console.log(`[Broadcast] Checking message ${i}: role=${msg.role}, hasUsage=${!!msg.usage}`);
      if (msg.role === "assistant" && msg.usage) {
        const usage = msg.usage;
        console.log("[Broadcast] Found usage:", usage);
        return {
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
          total: (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0),
          cost: usage.cost?.total,
        };
      }
    }
    console.log("[Broadcast] No usage data found in messages");
    return undefined;
  }

  // MARK: - Slash Command Handlers

  async handleModelCommand(args: string): Promise<string> {
    const arg = args.trim();

    // No args - show current model
    if (!arg) {
      const state = await this.pi.getState();
      const stateData = state.data as { model?: { id: string; provider: string; name: string } } | undefined;
      const model = stateData?.model;
      return model 
        ? `Current model: ${model.provider}/${model.id} (${model.name})`
        : "Current model: (unknown)";
    }

    // List available models
    if (arg === "list") {
      const response = await this.pi.getAvailableModels();
      if (!response.success || !response.data) {
        return "Failed to get available models.";
      }

      const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
      const models = data.models ?? [];

      const state = await this.pi.getState();
      const stateData = state.data as { model?: { id: string; provider: string } } | undefined;
      const currentModel = stateData?.model;

      const lines = models.map((m, i) => {
        const prefix = currentModel?.provider === m.provider && currentModel?.id === m.id ? "> " : "  ";
        return `${prefix}${i + 1}. ${m.provider}/${m.id} (${m.name})`;
      });

      return ["Available models:", ...lines].join("\n");
    }

    // Switch to model by number
    const index = parseInt(arg, 10);
    if (isNaN(index) || index < 1) {
      return "Invalid number. Use /model list to see available models.";
    }

    const response = await this.pi.getAvailableModels();
    if (!response.success || !response.data) {
      return "Failed to get available models.";
    }

    const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
    const models = data.models ?? [];

    if (index > models.length) {
      return `Model ${index} not found. Use /model list to see available models (1-${models.length}).`;
    }

    const selected = models[index - 1];

    try {
      await this.pi.setModelViaRpc(selected.provider, selected.id);
      return `Model changed to ${selected.provider}/${selected.id} (${selected.name})`;
    } catch (err) {
      return `Failed to set model: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  async handleSessionCommand(): Promise<string> {
    const state = await this.pi.getState();
    const stateData = state.data as { 
      model?: { id: string; provider: string };
      contextWindow?: number;
      compactThreshold?: number;
    } | undefined;
    
    const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
    
    const lines: string[] = [];
    
    if (stateData?.model) {
      lines.push(`**Model:** ${stateData.model.provider}/${stateData.model.id}`);
    }
    
    if (stateData?.contextWindow) {
      lines.push(`**Context Window:** ${fmt(stateData.contextWindow)} tokens`);
    }
    
    if (stateData?.compactThreshold) {
      lines.push(`**Compact Threshold:** ${fmt(stateData.compactThreshold)} tokens`);
    }
    
    return lines.length > 0 ? lines.join("\n") : "Session info unavailable";
  }

  async handleNewCommand(): Promise<string> {
    if (!this.sessionManager) {
      return "❌ Session manager not available. Please restart the gateway.";
    }

    const result = await this.sessionManager.archiveAndStartNew();

    if (result.error) {
      return `❌ Failed to start new session: ${result.error}`;
    }

    return [
      `✅ New session started`,
      ``,
      `Archived: ${result.archived}`,
    ].join("\n");
  }

  async handleTakeoverCommand(): Promise<string> {
    return "Takeover command not yet implemented for WebSocket clients.";
  }
}
