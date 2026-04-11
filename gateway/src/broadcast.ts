import type { EventEmitter } from "node:events";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent } from "./types.js";
import type { Client, WSServerMessage, WSStateData } from "./types-ws.js";
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
  private currentPrompt:
    | { message: string; clientIds: Set<string>; startedAt: number; originClientId: string }
    | null = null;
  private sessionManager: SessionManager | null = null;
  private lastUserActivityAt = 0;

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
    if (this.currentPrompt || this.pi.isPromptActive) {
      throw new Error("Assistant is busy with another prompt");
    }

    this.lastUserActivityAt = Date.now();

    // Track which clients are participating in this prompt
    const clientIds = new Set(this.clients.keys());
    this.currentPrompt = { message, clientIds, startedAt: Date.now(), originClientId: originatingClientId };

    // Broadcast user message to all OTHER clients (sender already showed it locally)
    await this.broadcast({
      type: "user_message",
      data: { content: message, source: originatingClientId },
    }, originatingClientId);

    // Send prompt to Pi (this starts the streaming)
    // Note: We don't await here - Pi runs asynchronously and emits events
    this.pi.prompt(message, { source: "user" }).catch((err) => {
      console.error("[Broadcast] Pi prompt error:", err);
      this.currentPrompt = null;
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
    if (this.currentPrompt || this.pi.isPromptActive) {
      throw new Error("Assistant is busy with another prompt");
    }

    this.lastUserActivityAt = Date.now();

    // Track which clients are participating in this prompt
    const clientIds = new Set(this.clients.keys());
    this.currentPrompt = { message, clientIds, startedAt: Date.now(), originClientId: originatingClientId };

    console.log(`[Broadcast] Sending prompt with ${images.length} image(s) to Pi`);

    // Send prompt with images to Pi (this starts the streaming)
    // Note: We don't await here - Pi runs asynchronously and emits events
    // Strip paths before sending to Pi (Pi only needs base64)
    const piImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
    this.pi.promptWithImages(message, piImages, { source: "user" }).catch((err) => {
      console.error("[Broadcast] Pi promptWithImages error:", err);
      this.currentPrompt = null;
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
  async getState(): Promise<{ type: "state"; data: WSStateData }> {
    try {
      const stateResponse = await this.pi.getState();
      
      const stateData = stateResponse.data as { 
        model?: { id: string; provider: string };
        messageCount?: number;
      } | undefined;

      const currentContextTokens = await this.readCurrentContextTokensFromSession();

      return {
        type: "state",
        data: {
          model: stateData?.model?.id,
          provider: stateData?.model?.provider,
          contextTokens: currentContextTokens ?? undefined,
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

  private async readCurrentContextTokensFromSession(): Promise<number | null> {
    try {
      const { readFile } = await import("node:fs/promises");
      const sessionPath = this.sessionManager?.["sessionPath"] || "";
      if (!sessionPath) return null;

      const content = await readFile(sessionPath, "utf-8");
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
      // ignore - session may be empty/unavailable
    }
    return null;
  }

  /**
   * Abort current Pi operation
   */
  abort(): void {
    this.pi.abort();
  }

  isPromptInFlight(): boolean {
    return this.currentPrompt !== null || this.pi.isPromptActive;
  }

  hasRecentUserActivity(windowMs: number): boolean {
    if (this.lastUserActivityAt === 0) return false;
    return Date.now() - this.lastUserActivityAt < windowMs;
  }

  private setupPiListeners(): void {
    // Track accumulated text for final response
    let currentText = "";
    let insideTool = false;
    let currentThinking = "";
    const lastToolOutputById = new Map<string, string>();
    let eventQueue: Promise<void> = Promise.resolve();

    const handlePiEvent = async (
      event: PiEvent,
      promptSource: "user" | "internal" | null
    ): Promise<void> => {
      if (promptSource !== "user") {
        if (event.type === "agent_end") {
          console.log(
            `[Broadcast] Ignoring agent_end for non-user prompt (source=${promptSource ?? "unknown"})`
          );
        }
        if (event.type === "agent_end") {
          currentThinking = "";
          lastToolOutputById.clear();
          insideTool = false;
        }
        return;
      }

      // Handle tool execution events
      if (event.type === "tool_execution_start") {
        insideTool = true;

        const label = this.formatToolLabel(event.toolName || "tool", event.args);

        await this.broadcast({
          type: "tool_start",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            args: event.args,
            label,
          },
        });

        // Create tool result block immediately so user can see live updates/abort context.
        await this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: "",
            truncated: false,
          },
        });
        lastToolOutputById.set(event.toolCallId, "");
      }

      if (event.type === "tool_execution_update") {
        const outputText = this.extractToolResultText(event.partialResult);
        const truncated = this.truncateToolOutput(outputText);
        const prev = lastToolOutputById.get(event.toolCallId) ?? "";

        if (truncated.text !== prev) {
          lastToolOutputById.set(event.toolCallId, truncated.text);
          await this.broadcast({
            type: "tool_output",
            data: {
              toolCallId: event.toolCallId,
              output: truncated.text,
              truncated: truncated.wasTruncated,
            },
          });
        }
      }

      if (event.type === "tool_execution_end") {
        const result = "result" in event ? (event as Record<string, unknown>).result : null;

        const images = this.extractImagesFromToolResult(result);
        for (const image of images) {
          await this.broadcast({
            type: "image",
            data: {
              source: image.source,
              alt: image.alt,
            },
          });
        }

        const outputText = this.extractToolResultText(result);
        const truncated = this.truncateToolOutput(outputText);

        await this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: truncated.text,
            truncated: truncated.wasTruncated,
          },
        });
        lastToolOutputById.delete(event.toolCallId);

        await this.broadcast({
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

          // Skip heartbeat responses
          const delta = msgEvent.delta;
          if (delta.includes("[[NO_ACTION]]") || delta.startsWith("[Heartbeat]")) {
            // Heartbeat response - don't broadcast
          } else if (!insideTool) {
            // Only broadcast prose deltas (not tool output)
            await this.broadcast({
              type: "text_delta",
              data: { content: delta },
            });
          }
        }

        if (msgEvent.type === "text_done") {
          // Important: Use Pi's finalized text (can include corrected spacing/token joins)
          currentText = msgEvent.text;
        }

        if (msgEvent.type === "thinking_delta") {
          currentThinking += msgEvent.delta;
          // Skip heartbeat responses
          const delta = msgEvent.delta;
          if (!delta.includes("[[NO_ACTION]]") && !delta.startsWith("[Heartbeat]")) {
            await this.broadcast({
              type: "thinking_delta",
              data: { content: delta },
            });
          }
        }

        if (msgEvent.type === "thinking_done") {
          await this.broadcast({
            type: "thinking_done",
            data: { content: currentThinking },
          });
          currentThinking = "";
        }
      }

      // Handle completion
      if (event.type === "agent_end") {
        const proseResponse = currentText;
        const completedPrompt = this.currentPrompt;
        const durationMs = completedPrompt ? Date.now() - completedPrompt.startedAt : undefined;
        if (!completedPrompt) {
          console.warn(
            `[Broadcast] Received user agent_end with no tracked prompt; finalLen=${proseResponse.length}`
          );
        }

        const imageExtractions = this.extractMarkdownImages(proseResponse);
        for (const image of imageExtractions.images) {
          await this.broadcast({
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

        if (usage) {
          const truncatedResponse = proseResponse.length > 200 
            ? proseResponse.slice(0, 200).replace(/\s+/g, " ").trim() + "..."
            : proseResponse.replace(/\s+/g, " ").trim();
          const durationText = durationMs !== undefined ? ` | Duration: ${(durationMs / 1000).toFixed(1)}s` : "";
          console.log(
            `[Broadcast] Done: ${usage.total.toLocaleString()} tokens (in=${usage.input} out=${usage.output} cache=${usage.cacheRead}) $${(usage.cost ?? 0).toFixed(4)}${durationText} | Response: ${truncatedResponse || "(empty)"}`
          );
        } else if (durationMs !== undefined) {
          console.log(`[Broadcast] Done: Duration ${(durationMs / 1000).toFixed(1)}s`);
        }
        await this.broadcast({
          type: "done",
          data: { finalText: imageExtractions.textOnly, usage },
        });

        // Reset state for next prompt
        currentText = "";
        insideTool = false;
        this.currentPrompt = null;
      }
    };

    // Rate limiting for events to prevent CPU spin
    let lastEventTime = 0;
    let eventCount = 0;
    const RATE_WINDOW_MS = 1000;
    const MAX_EVENTS_PER_WINDOW = 1000;

    this.pi.on("event", (event: PiEvent) => {
      const now = Date.now();
      if (now - lastEventTime > RATE_WINDOW_MS) {
        lastEventTime = now;
        eventCount = 0;
      }
      eventCount++;
      
      if (eventCount > MAX_EVENTS_PER_WINDOW) {
        if (eventCount === MAX_EVENTS_PER_WINDOW + 1) {
          console.error("[Broadcast] Rate limit exceeded - suppressing events");
        }
        return;
      }

      const promptSource = this.pi.promptSource;

      eventQueue = eventQueue
        .then(() => handlePiEvent(event, promptSource))
        .catch((err) => {
          console.error("[Broadcast] Failed processing Pi event:", err);
        });
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
    if (!messages || !Array.isArray(messages)) {
      return undefined;
    }

    // Find the last assistant message with usage data
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
          totalTokens?: number;
          cost?: { total?: number } | number
        }
      };
      if (msg.role === "assistant" && msg.usage) {
        const usage = msg.usage;
        // Handle different cost formats (number or { total: number })
        let costValue: number | undefined;
        if (typeof usage.cost === "number") {
          costValue = usage.cost;
        } else if (usage.cost && typeof usage.cost === "object") {
          costValue = usage.cost.total;
        }
        return {
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
          total: usage.total ?? usage.totalTokens ?? ((usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)),
          cost: costValue,
        };
      }
    }
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

  /**
   * Get list of available models for WebSocket clients
   */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name: string }>> {
    const response = await this.pi.getAvailableModels();
    if (!response.success || !response.data) {
      return [];
    }
    const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
    return data.models ?? [];
  }

  /**
   * Switch to a specific model by provider and id
   */
  async switchModel(provider: string, modelId: string): Promise<{ success: boolean; model?: { provider: string; id: string; name: string }; error?: string }> {
    try {
      // Get available models to validate and get name
      const models = await this.getAvailableModels();
      const model = models.find(m => m.provider === provider && m.id === modelId);
      
      if (!model) {
        return { success: false, error: `Model ${provider}/${modelId} not found` };
      }

      await this.pi.setModelViaRpc(provider, modelId);
      return { success: true, model };
    } catch (err) {
      return { 
        success: false, 
        error: err instanceof Error ? err.message : "Failed to switch model" 
      };
    }
  }

  async handleSessionCommand(): Promise<string> {
    const state = await this.pi.getState();
    const stateData = state.data as { 
      model?: { id: string; provider: string; name?: string };
      contextWindow?: number;
      compactThreshold?: number;
    } | undefined;
    
    const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
    
    const lines: string[] = [];
    
    // Get current token usage from session file
    let currentTokens = 0;
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(this.sessionManager?.['sessionPath'] || "", "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
          const u = entry.message.usage;
          currentTokens = (u.cacheRead ?? 0) + (u.inputTokens ?? 0);
          break;
        }
      }
    } catch (err) {
      // ignore
    }
    
    if (stateData?.model) {
      lines.push(`**Model:** ${stateData.model.provider}/${stateData.model.id}`);
    }
    
    if (stateData?.contextWindow) {
      lines.push(`**Context Window:** ${fmt(stateData.contextWindow)} tokens`);
    }
    
    if (stateData?.compactThreshold) {
      lines.push(`**Compact Threshold:** ${fmt(stateData.compactThreshold)} tokens`);
      if (currentTokens > 0) {
        const pct = Math.min(100, Math.round((currentTokens / stateData.compactThreshold) * 100));
        lines.push(`**Current Usage:** ${fmt(currentTokens)} tokens (${pct}%)`);
        if (pct >= 90) {
          lines.push(`⚠️ **Compaction imminent** - context approaching threshold`);
        } else if (pct >= 75) {
          lines.push(`⚡ **Compaction approaching** - consider starting fresh soon`);
        }
      }
    }
    
    // Compaction count
    const compactionCount = this.sessionManager?.['compactionCount'] ?? 0;
    lines.push(`**Compactions this session:** ${compactionCount}`);
    
    return lines.length > 0 ? lines.join("\n") : "Session info unavailable";
  }
  
  /**
   * Get detailed session status for WebSocket clients
   */
  async getSessionStatus(): Promise<{
    model?: { provider: string; id: string; name?: string };
    contextWindow?: number;
    compactThreshold?: number;
    currentTokens: number;
    percentage: number;
    compactionCount: number;
  }> {
    const state = await this.pi.getState();
    const stateData = state.data as { 
      model?: { id: string; provider: string; name?: string };
      contextWindow?: number;
      compactThreshold?: number;
    } | undefined;
    
    // Get current token usage from session file
    const currentTokens = (await this.readCurrentContextTokensFromSession()) ?? 0;
    
    const compactThreshold = stateData?.compactThreshold ?? 0;
    const percentage = compactThreshold > 0 
      ? Math.min(100, Math.round((currentTokens / compactThreshold) * 100))
      : 0;
    
    return {
      model: stateData?.model,
      contextWindow: stateData?.contextWindow,
      compactThreshold,
      currentTokens,
      percentage,
      compactionCount: this.sessionManager?.['compactionCount'] ?? 0,
    };
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
