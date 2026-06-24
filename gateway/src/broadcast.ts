import type { EventEmitter } from "node:events";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent } from "./types.js";
import type { Client, TokenUsage, WSServerMessage, WSStateData } from "./types-ws.js";
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
    | {
        message: string;
        turnId: string;
        clientIds: Set<string>;
        startedAt: number;
        originClientId: string;
        origin: "user" | "task";
        taskId?: string;
        taskRunId?: string;
        taskName?: string;
      }
    | null = null;
  private sessionManager: SessionManager | null = null;
  private lastUserActivityAt = 0;
  private promptQueue: Promise<unknown> = Promise.resolve();
  // Cumulative session token usage
  private cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

  private broadcastThinking: boolean;

  constructor(
    private pi: PiRpcClient,
    options?: { broadcastThinking?: boolean }
  ) {
    this.broadcastThinking = options?.broadcastThinking ?? true;
    this.setupPiListeners();
    this.setupPiExitHandler();
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
  async sendPrompt(message: string, originatingClientId: string, requestedTurnId?: string): Promise<Set<string>> {
    // Serialize through promptQueue to prevent race between user and task prompts
    let resolveResult!: (value: Set<string>) => void;
    let rejectResult!: (error: Error) => void;
    const resultPromise = new Promise<Set<string>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.promptQueue = this.promptQueue.then(async () => {
      if (this.currentPrompt) {
        rejectResult(new Error("Assistant is busy with another prompt"));
        return;
      }

      if (this.pi.isPromptActive) {
        console.log("[Broadcast] User prompt queued behind active internal prompt (heartbeat)");
      }

      this.lastUserActivityAt = Date.now();

      const clientIds = new Set(this.clients.keys());
      const turnId = this.resolveTurnId(requestedTurnId, originatingClientId);
      this.currentPrompt = {
        message,
        turnId,
        clientIds,
        startedAt: Date.now(),
        originClientId: originatingClientId,
        origin: "user",
      };

      const preview = message.length > 60 ? message.slice(0, 60).replace(/\s+/g, " ").trim() + "..." : message;
      console.log(`[Broadcast] Prompt processing started (from ${originatingClientId}, ${clientIds.size} client${clientIds.size === 1 ? "" : "s"}): "${preview}"`);

      await this.broadcast({
        type: "user_message",
        data: { content: message, source: originatingClientId, ...this.turnMetadata() },
      }, originatingClientId);

      this.pi.prompt(message, { source: "user", id: turnId }).catch((err) => {
        console.error("[Broadcast] Pi prompt error:", err);
        const metadata = this.turnMetadata();
        this.currentPrompt = null;
        this.broadcast({
          type: "error",
          data: { message: err instanceof Error ? err.message : "Unknown error", ...metadata },
        });
      });

      resolveResult(clientIds);
    }).catch((err) => {
      // If the queue chain itself fails, reject the result promise
      try { rejectResult(err instanceof Error ? err : new Error(String(err))); } catch { /* already settled */ }
    });

    return resultPromise;
  }

  async sendTaskPrompt(input: {
    taskId: string;
    runId: string;
    taskName: string;
    prompt: string;
  }): Promise<string> {
    const run = this.promptQueue.then(() => this.runTaskPrompt(input));
    this.promptQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Send a prompt with images to Pi and broadcast to all clients
   * Returns the clients that will receive this response
   */
  async sendPromptWithImages(
    message: string,
    images: { data: string; mimeType: string; path?: string }[],
    originatingClientId: string,
    requestedTurnId?: string
  ): Promise<Set<string>> {
    if (this.currentPrompt) {
      throw new Error("Assistant is busy with another prompt");
    }
    // Internal prompts (heartbeat) are non-blocking — they queue behind the user prompt
    if (this.pi.isPromptActive) {
      console.log("[Broadcast] User prompt (with images) queued behind active internal prompt (heartbeat)");
    }

    this.lastUserActivityAt = Date.now();

    // Track which clients are participating in this prompt
    const clientIds = new Set(this.clients.keys());
    const turnId = this.resolveTurnId(requestedTurnId, originatingClientId);
    this.currentPrompt = {
      message,
      turnId,
      clientIds,
      startedAt: Date.now(),
      originClientId: originatingClientId,
      origin: "user",
    };

    const preview = message.length > 60 ? message.slice(0, 60).replace(/\s+/g, " ").trim() + "..." : message;
    console.log(`[Broadcast] Prompt processing started (from ${originatingClientId}, ${clientIds.size} client${clientIds.size === 1 ? "" : "s"}): "${preview}" (${images.length} image(s))`);

    // Send prompt with images to Pi (this starts the streaming)
    // Note: We don't await here - Pi runs asynchronously and emits events
    // Strip paths before sending to Pi (Pi only needs base64)
    const piImages = images.map(({ data, mimeType }) => ({ data, mimeType }));
    this.pi.promptWithImages(message, piImages, { source: "user", id: turnId }).catch((err) => {
      console.error("[Broadcast] Pi promptWithImages error:", err);
      const metadata = this.turnMetadata();
      this.currentPrompt = null;
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : "Unknown error", ...metadata },
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
        model?: { id: string; provider: string; name: string; contextWindow?: number };
        messageCount?: number;
      } | undefined;

      const currentContextTokens = await this.readCurrentContextTokensFromSession();

      return {
        type: "state",
        data: {
          model: stateData?.model ? { id: stateData.model.id, provider: stateData.model.provider, name: stateData.model.name } : undefined,
          contextWindow: stateData?.model?.contextWindow,
          contextTokens: currentContextTokens ?? undefined,
          isProcessing: false,
          sessionUsage: {
            input: this.cumulativeUsage.input,
            output: this.cumulativeUsage.output,
            cacheRead: this.cumulativeUsage.cacheRead,
            cacheWrite: this.cumulativeUsage.cacheWrite,
            total: this.cumulativeUsage.total,
            cost: this.cumulativeUsage.cost || undefined,
          },
        },
      };
    } catch (err) {
      console.error("[Broadcast] getState failed:", err);
      return {
        type: "state",
        data: {
          isProcessing: false,
          sessionUsage: {
            input: this.cumulativeUsage.input,
            output: this.cumulativeUsage.output,
            cacheRead: this.cumulativeUsage.cacheRead,
            cacheWrite: this.cumulativeUsage.cacheWrite,
            total: this.cumulativeUsage.total,
            cost: this.cumulativeUsage.cost || undefined,
          },
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

  private async runTaskPrompt(input: {
    taskId: string;
    runId: string;
    taskName: string;
    prompt: string;
  }): Promise<string> {
    await this.waitForIdle();

    const clientIds = new Set(this.clients.keys());
    const turnId = this.resolveTurnId(input.runId, "task");
    this.currentPrompt = {
      message: input.prompt,
      turnId,
      clientIds,
      startedAt: Date.now(),
      originClientId: "task",
      origin: "task",
      taskId: input.taskId,
      taskRunId: input.runId,
      taskName: input.taskName,
    };

    console.log(
      `[Broadcast] Task prompt started (${input.taskId}, ${clientIds.size} client${clientIds.size === 1 ? "" : "s"}): "${input.taskName}"`
    );

    try {
      return await this.pi.prompt(input.prompt, { source: "user", id: turnId });
    } catch (error) {
      const metadata = this.turnMetadata();
      this.currentPrompt = null;
      await this.broadcast({
        type: "error",
        data: {
          message: error instanceof Error ? error.message : "Task prompt failed",
          ...metadata,
        },
      });
      throw error;
    }
  }

  private async waitForIdle(timeoutMs = 10 * 60 * 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.isPromptInFlight()) {
      if (Date.now() > deadline) {
        throw new Error(`waitForIdle timed out after ${timeoutMs / 1000}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private turnMetadata():
    | {
        turnId: string;
        originClientId: string;
        origin?: "task";
        taskId?: string;
        taskRunId?: string;
        taskName?: string;
      }
    | Record<string, never> {
    const prompt = this.currentPrompt;
    if (!prompt) return {};
    const metadata = {
      turnId: prompt.turnId,
      originClientId: prompt.originClientId,
    };
    if (prompt.origin !== "task" || !prompt.taskId || !prompt.taskRunId) return metadata;
    return { ...metadata, origin: "task", taskId: prompt.taskId, taskRunId: prompt.taskRunId, taskName: prompt.taskName };
  }

  private resolveTurnId(requestedTurnId: string | undefined, originClientId: string): string {
    const sanitized = requestedTurnId?.trim();
    if (sanitized) return sanitized;
    return `${originClientId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private setupPiListeners(): void {
    // Track accumulated text for final response
    let currentText = "";
    let insideTool = false;
    let currentThinking = "";
    let currentThinkingId: string | null = null;
    let thinkingSeq = 0;
    const lastToolOutputById = new Map<string, string>();
    let eventQueue: Promise<void> = Promise.resolve();

    const flushThinkingBlock = async (): Promise<void> => {
      if (!currentThinkingId) return;
      if (this.broadcastThinking) {
        await this.broadcast({
          type: "thinking_done",
          data: {
            thinkingId: currentThinkingId,
            content: currentThinking,
            seq: thinkingSeq,
            ...this.turnMetadata(),
          },
        });
      }
      currentThinking = "";
      currentThinkingId = null;
    };

    let suppressedEventsLogged = false;

    const handlePiEvent = async (
      event: PiEvent,
      promptSource: "user" | "internal" | null
    ): Promise<void> => {
      if (promptSource !== "user") {
        // Log one line per suppressed turn block, not per event
        if (!suppressedEventsLogged) {
          suppressedEventsLogged = true;
          console.log(
            `[Broadcast] Suppressing events for non-user prompt (source=${promptSource ?? "unknown"})`
          );
        }
        if (event.type === "agent_end") {
          currentThinking = "";
          currentThinkingId = null;
          lastToolOutputById.clear();
          insideTool = false;
          suppressedEventsLogged = false;
        }
        return;
      } else {
        // Reset flag when transitioning to a user prompt
        suppressedEventsLogged = false;
      }

      // Handle tool execution events
      if (event.type === "tool_execution_start") {
        // Pi may transition straight from thinking into a tool call without an explicit
        // thinking_done event. Close the active thinking block here so resumed reasoning
        // after the tool starts a fresh block below the tool lifecycle.
        await flushThinkingBlock();
        insideTool = true;

        const label = this.formatToolLabel(event.toolName || "tool", event.args);

        await this.broadcast({
          type: "tool_start",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            args: event.args,
            label,
            ...this.turnMetadata(),
          },
        });

        // Create tool result block immediately so user can see live updates/abort context.
        await this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: "",
            truncated: false,
            ...this.turnMetadata(),
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
              ...this.turnMetadata(),
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
              ...this.turnMetadata(),
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
            ...this.turnMetadata(),
          },
        });
        lastToolOutputById.delete(event.toolCallId);

        await this.broadcast({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            ...this.turnMetadata(),
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
              data: { content: delta, ...this.turnMetadata() },
            });
          }
        }

        if (msgEvent.type === "text_done") {
          // Important: Use Pi's finalized text (can include corrected spacing/token joins)
          currentText = msgEvent.text;
        }

        if (msgEvent.type === "thinking_delta") {
          if (!currentThinkingId) {
            currentThinkingId = `thinking-${++thinkingSeq}`;
          }
          currentThinking += msgEvent.delta;
          // Skip heartbeat responses
          const delta = msgEvent.delta;
          if (
            this.broadcastThinking &&
            !delta.includes("[[NO_ACTION]]") &&
            !delta.startsWith("[Heartbeat]")
          ) {
            await this.broadcast({
              type: "thinking_delta",
              data: { thinkingId: currentThinkingId, content: delta, seq: thinkingSeq, ...this.turnMetadata() },
            });
          }
        }

        if (msgEvent.type === "thinking_done" && currentThinkingId) {
          await flushThinkingBlock();
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
              ...this.turnMetadata(),
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

        // Enrich usage with cumulative totals and context estimate
        let enrichedUsage: TokenUsage | undefined = usage;
        if (usage) {
          this.cumulativeUsage.input += usage.input;
          this.cumulativeUsage.output += usage.output;
          this.cumulativeUsage.cacheRead += usage.cacheRead;
          this.cumulativeUsage.cacheWrite += usage.cacheWrite;
          this.cumulativeUsage.total += usage.total;
          if (usage.cost) this.cumulativeUsage.cost += usage.cost;

          enrichedUsage = {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            total: usage.total,
            cost: usage.cost,
            cumulative: {
              input: this.cumulativeUsage.input,
              output: this.cumulativeUsage.output,
              cacheRead: this.cumulativeUsage.cacheRead,
              cacheWrite: this.cumulativeUsage.cacheWrite,
              total: this.cumulativeUsage.total,
              cost: this.cumulativeUsage.cost || undefined,
            },
            contextTokens: usage.cacheRead + usage.input,
          };
        }

        await flushThinkingBlock();

        await this.broadcast({
          type: "done",
          data: { finalText: imageExtractions.textOnly, usage: enrichedUsage, ...this.turnMetadata() },
        });

        // Reset state for next prompt
        currentText = "";
        currentThinking = "";
        currentThinkingId = null;
        insideTool = false;
        this.currentPrompt = null;
      }
    };

    // Rate limiting for events to prevent CPU spin.
    // Lifecycle events (agent_end, etc.) must never be suppressed or the
    // gateway enters a stuck state where currentPrompt is never cleared.
    const LIFECYCLE_EVENTS = new Set(["agent_end"]);
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

      if (eventCount > MAX_EVENTS_PER_WINDOW && !LIFECYCLE_EVENTS.has(event.type)) {
        if (eventCount === MAX_EVENTS_PER_WINDOW + 1) {
          console.error("[Broadcast] Rate limit exceeded - suppressing non-lifecycle events");
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
        return "";
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

  /**
   * Listen for Pi process exit so we can clear state instead of getting stuck.
   */
  private setupPiExitHandler(): void {
    this.pi.on("exit", (code) => {
      if (this.currentPrompt) {
        console.warn(
          `[Broadcast] Pi process exited (code=${code}) with active prompt - clearing state and notifying clients`
        );
        const metadata = this.turnMetadata();
        this.broadcast({
          type: "error",
          data: { message: "Assistant process exited - please start a new session", ...metadata },
        }).catch(() => {});
        this.currentPrompt = null;
      }
    });
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

      // Broadcast model change to all WS clients
      await this.broadcast({
        type: "model_switched",
        data: { success: true, model: { provider: selected.provider, id: selected.id, name: selected.name } },
      });

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

      // Broadcast model change to all clients
      await this.broadcast({
        type: "model_switched",
        data: { success: true, model: { provider: model.provider, id: model.id, name: model.name } },
      });

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

    // Reset cumulative usage for new session
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

    if (result.error) {
      return `❌ Failed to start new session: ${result.error}`;
    }

    return [
      `✅ New session started`,
      ``,
      `Archived: ${result.archived}`,
    ].join("\n");
  }

  }
