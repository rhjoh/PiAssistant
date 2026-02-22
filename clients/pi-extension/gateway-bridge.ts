/**
 * Gateway Bridge Extension for Pi
 * 
 * Connects Pi TUI to the Gateway WebSocket server by registering a custom
 * model provider. Pi's agent loop runs normally, but LLM calls are routed
 * to Gateway via WebSocket.
 * 
 * Usage:
 *   pi extensions enable gateway-bridge
 *   pi /model  # Select "gateway/bridge" model
 * 
 * Or test once:
 *   pi -e ~/.pi/agent/extensions/gateway-bridge.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";

interface GatewayConfig {
  host: string;
  port: number;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
}

/**
 * Events from Gateway → Pi
 */
type GatewayEvent =
  | { type: "connected" }
  | { type: "turn_start"; turnId: string; seq: number }
  | { type: "text_delta"; turnId?: string; seq?: number; text: string }
  | { type: "text_done"; turnId?: string; seq?: number; text: string }
  | { type: "thinking_start" }
  | { type: "thinking"; turnId?: string; seq?: number; text: string } // legacy/simple thinking delta
  | { type: "thinking_delta"; turnId?: string; seq?: number; text: string }
  | { type: "thinking_done"; turnId?: string; seq?: number }
  | { type: "tool_execution_start"; turnId?: string; seq?: number; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; turnId?: string; seq?: number; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; turnId?: string; seq?: number; toolCallId: string; toolName: string; result: unknown; isError?: boolean; args?: Record<string, unknown> }
  | { type: "image"; turnId?: string; seq?: number; data: string; mimeType: string }
  | { type: "done"; turnId?: string; seq?: number; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { type: "turn_end"; turnId: string; seq: number; stopReason: "stop" | "toolUse" | "error" | "aborted" }
  | { type: "error"; turnId?: string; seq?: number; message: string };

/**
 * WebSocket-based provider that connects to Gateway
 */
class GatewayProvider {
  private ws: WebSocket | null = null;
  private config: GatewayConfig;
  private reconnectAttempts = 0;
  private isConnected = false;
  private pendingStream: AssistantMessageEventStream | null = null;
  private currentOutput: AssistantMessage | null = null;
  private streamEnded = false;
  private sawToolCallInTurn = false;
  private activeToolCallsInTurn = new Set<string>();
  private preToolTextBuffer = "";
  private preToolTextDone: string | null = null;
  private postToolTextBuffer = "";
  private postToolTextDone: string | null = null;
  private pendingFollowUpText: string | null = null;
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, config?: Partial<GatewayConfig>) {
    this.pi = pi;
    this.config = {
      host: config?.host ?? "localhost",
      port: config?.port ?? 3456,
      reconnectIntervalMs: config?.reconnectIntervalMs ?? 5000,
      maxReconnectAttempts: config?.maxReconnectAttempts ?? 10,
    };
  }

  /**
   * Main streaming function - called by Pi's agent loop
   */
  stream(
    _model: Model<"gateway">,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    this.pendingStream = stream;

    // Run the streaming process
    this.runStream(context, stream, options).catch((err) => {
      console.error("[GatewayBridge] Stream error:", err);
      if (!this.streamEnded) {
        this.streamEnded = true;
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [{ type: "text", text: `Gateway error: ${err}` }],
            api: "gateway",
            provider: "gateway",
            model: "bridge",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: String(err),
            timestamp: Date.now(),
          },
        });
        stream.end();
      }
    });

    return stream;
  }

  private clearToolTracking: (() => void) | null = null;

  setToolTrackingClear(fn: () => void): void {
    this.clearToolTracking = fn;
  }

  private async runStream(
    context: Context,
    stream: AssistantMessageEventStream,
    options?: SimpleStreamOptions
  ): Promise<void> {
    // Clear tool tracking state from previous turn
    this.clearToolTracking?.();

    // Connect to Gateway
    await this.ensureConnected();

    // Initialize output message
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "gateway",
      provider: "gateway",
      model: "bridge",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    this.currentOutput = output;
    this.streamEnded = false;
    this.sawToolCallInTurn = false;
    this.activeToolCallsInTurn.clear();
    this.preToolTextBuffer = "";
    this.preToolTextDone = null;
    this.postToolTextBuffer = "";
    this.postToolTextDone = null;

    // Push start event
    stream.push({ type: "start", partial: output });

    // If the last message is a tool result, this is Pi's automatic follow-up turn
    // after executing tool calls. Do not re-send the user prompt (that causes loops).
    // Instead, emit any buffered post-tool prose from the previous Gateway turn.
    const lastMessage = context.messages[context.messages.length - 1] as { role?: string } | undefined;
    if (lastMessage?.role === "toolResult") {
      const followUp = (this.pendingFollowUpText ?? "").trim();
      if (followUp.length > 0) {
        output.content.push({ type: "text", text: followUp });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: followUp, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: followUp, partial: output });
      }
      this.pendingFollowUpText = null;
      this.streamEnded = true;
      stream.push({
        type: "done",
        reason: "stop",
        message: output,
      });
      stream.end();
      return;
    }

    // Send prompt to Gateway
    const lastUserMessage = context.messages
      .filter((m) => m.role === "user")
      .pop();

    if (!lastUserMessage) {
      throw new Error("No user message found in context");
    }

    const userText = typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : lastUserMessage.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");

    // Set up WebSocket message handler
    this.setupStreamHandler(stream, output, options);

    const abortSignal = options?.signal;
    const onAbort = () => {
      this.sendAbort();
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        this.sendAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      // Send prompt
      this.sendPrompt(userText);

      // Wait for completion or abort
      await this.waitForCompletion(abortSignal);
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    }

    // If we got here without ending, push done
    if (!this.streamEnded) {
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      this.streamEnded = true;
      stream.end();
    }
  }

  private setupStreamHandler(
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    options?: SimpleStreamOptions
  ): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      // Check for abort
      if (options?.signal?.aborted) {
        if (this.streamEnded) return;
        output.stopReason = "aborted";
        this.streamEnded = true;
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      try {
        const data = JSON.parse(event.data as string) as GatewayEvent;
        this.handleGatewayEvent(data, stream, output);
      } catch (err) {
        console.error("[GatewayBridge] Failed to parse event:", err);
      }
    };
  }

  private handleGatewayEvent(
    event: GatewayEvent,
    stream: AssistantMessageEventStream,
    output: AssistantMessage
  ): void {
    switch (event.type) {
      case "turn_start": {
        this.activeToolCallsInTurn.clear();
        this.sawToolCallInTurn = false;
        this.preToolTextBuffer = "";
        this.preToolTextDone = null;
        this.postToolTextBuffer = "";
        this.postToolTextDone = null;
        break;
      }

      case "text_delta": {
        if (!this.sawToolCallInTurn) {
          this.preToolTextBuffer += event.text;
          break;
        }

        // For tool turns, never stream text inline. Ignore while active, then buffer
        // post-tool prose for the follow-up assistant turn.
        if (this.activeToolCallsInTurn.size > 0) break;
        this.postToolTextBuffer += event.text;
        break;
      }

      case "text_done": {
        if (!this.sawToolCallInTurn) {
          this.preToolTextDone = event.text;
          break;
        }

        if (this.activeToolCallsInTurn.size > 0) break;
        this.postToolTextDone = event.text;
        break;
      }

      case "thinking_start": {
        output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
        const index = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        break;
      }

      case "thinking":
      case "thinking_delta": {
        let index = output.content.findIndex((c) => c.type === "thinking");
        if (index === -1) {
          output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
          index = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        }

        const block = output.content[index] as { type: "thinking"; thinking: string; thinkingSignature?: string };
        block.thinking += event.text;
        stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: event.text,
          partial: output,
        });
        break;
      }

      case "thinking_done": {
        const index = output.content.findIndex((c) => c.type === "thinking");
        if (index !== -1) {
          const block = output.content[index] as { type: "thinking"; thinking: string; thinkingSignature?: string };
          stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
        }
        break;
      }

      case "tool_execution_start": {
        this.sawToolCallInTurn = true;
        this.preToolTextBuffer = "";
        this.preToolTextDone = null;

        const argumentsObject = event.args ?? {};
        this.activeToolCallsInTurn.add(event.toolCallId);

        const toolCall = {
          type: "toolCall" as const,
          id: event.toolCallId,
          name: event.toolName,
          arguments: argumentsObject,
        };

        output.content.push(toolCall);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        const argsJson = JSON.stringify(argumentsObject);
        if (argsJson.length > 0) {
          stream.push({ type: "toolcall_delta", contentIndex, delta: argsJson, partial: output });
        }
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });

        this.pi.events.emit("tool_execution_start", {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: argumentsObject,
        });

        this.pi.events.emit("gateway:tool_call", { id: event.toolCallId, name: event.toolName, arguments: argumentsObject });
        break;
      }

      case "tool_execution_update": {
        this.pi.events.emit("tool_execution_update", {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
          partialResult: event.partialResult,
        });
        break;
      }

      case "tool_execution_end": {
        this.activeToolCallsInTurn.delete(event.toolCallId);

        this.pi.events.emit("tool_execution_end", {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError ?? false,
        });

        output.content.push({
          type: "toolResult",
          toolCallId: event.toolCallId,
          toolName: event.toolName || "tool",
          result: event.result,
          isError: event.isError ?? false,
        });

        this.pi.events.emit("gateway:tool_result", {
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      }

      case "image": {
        output.content.push({
          type: "image",
          source: {
            type: "base64",
            mediaType: event.mimeType,
            data: event.data,
          },
        });
        // Images are added directly, no streaming events needed
        break;
      }

      case "done": {
        if (event.usage) {
          output.usage.input = event.usage.input;
          output.usage.output = event.usage.output;
          output.usage.cacheRead = event.usage.cacheRead;
          output.usage.cacheWrite = event.usage.cacheWrite;
          output.usage.totalTokens = event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
        }

        if (this.sawToolCallInTurn) {
          const postToolRaw = (this.postToolTextDone ?? this.postToolTextBuffer).trim();
          this.pendingFollowUpText = this.stripLeadingCodeFences(postToolRaw);
        } else {
          const finalText = (this.preToolTextDone ?? this.preToolTextBuffer).trim();
          if (finalText.length > 0) {
            const textIndex = output.content.findIndex((c) => c.type === "text");
            if (textIndex === -1) {
              output.content.push({ type: "text", text: finalText });
            } else {
              const textBlock = output.content[textIndex] as { type: "text"; text: string };
              textBlock.text = finalText;
            }
          }
        }

        const reason = this.sawToolCallInTurn ? "toolUse" : "stop";
        output.stopReason = reason;

        this.streamEnded = true;
        stream.push({
          type: "done",
          reason,
          message: output,
        });
        stream.end();
        break;
      }

      case "turn_end": {
        // Contract marker only; completion is driven by done/error events.
        break;
      }

      case "error": {
        output.stopReason = "error";
        output.errorMessage = event.message;
        this.streamEnded = true;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
        break;
      }
    }
  }

  private stripLeadingCodeFences(text: string): string {
    let out = text.trim();
    const fencePattern = /^```[\s\S]*?```\s*/;
    while (fencePattern.test(out)) {
      out = out.replace(fencePattern, "").trim();
    }
    return out;
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    await this.connect();
  }



  private async connect(): Promise<void> {
    const url = `ws://${this.config.host}:${this.config.port}/pi-client`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.pi.events.emit("gateway:connection", { connected: true });
        resolve();
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.pi.events.emit("gateway:connection", { connected: false });
        if (this.pendingStream && !this.streamEnded) {
          this.attemptReconnect();
        }
      };

      this.ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error("[GatewayBridge] WebSocket error:", err);
        if (!this.isConnected) {
          reject(err);
        }
      };
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error("[GatewayBridge] Max reconnection attempts reached");
      if (this.pendingStream && !this.streamEnded) {
        this.streamEnded = true;
        this.pendingStream.push({
          type: "error",
          reason: "error",
          error: this.currentOutput || {
            role: "assistant",
            content: [{ type: "text", text: "Connection lost" }],
            api: "gateway",
            provider: "gateway",
            model: "bridge",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error",
            errorMessage: "Connection lost",
            timestamp: Date.now(),
          },
        });
        this.pendingStream.end();
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts - 1),
      60000
    );

    setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[GatewayBridge] Reconnection failed:", err);
        this.attemptReconnect();
      });
    }, delay);
  }

  private sendPrompt(text: string): void {
    const payload = {
      type: "prompt",
      messages: [{ role: "user", content: text }],
      sessionId: "main",
    };

    this.ws?.send(JSON.stringify(payload));
  }

  private sendAbort(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "abort" }));
  }

  private async waitForCompletion(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.streamEnded) {
          clearInterval(checkInterval);
          resolve();
        }
        if (signal?.aborted) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Timeout after 10 minutes
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 600000);
    });
  }
}

/**
 * Extension factory function
 */
export default function gatewayBridgeExtension(pi: ExtensionAPI) {
  const argv = process.argv.join(" ");
  const isNonInteractivePiRun =
    argv.includes("--print")
    || argv.includes("--mode rpc");

  if (isNonInteractivePiRun) {
    // IMPORTANT: Never write to stdout here. Pi RPC expects stdout to be JSON-only.
    console.error("[GatewayBridge] Skipping extension init for non-interactive Pi run:", argv);
    return;
  }

  const provider = new GatewayProvider(pi);

  // Track tool calls that came from Gateway so we can intercept them
  const pendingToolResults = new Map<string, { result: unknown; isError?: boolean }>();
  const gatewayToolCallIds = new Set<string>();        // All tool calls from Gateway this turn
  const resolvedToolCallIds = new Set<string>();       // Tool calls whose results have been consumed
  const toolResultWaiters = new Map<string, Array<(result: { result: unknown; isError?: boolean }) => void>>();

  // Clear all tool tracking state at the start of each new turn
  const clearToolTracking = () => {
    pendingToolResults.clear();
    gatewayToolCallIds.clear();
    resolvedToolCallIds.clear();
    toolResultWaiters.clear();
  };

  // Pass the clear function to the provider so it can reset state on new turns
  provider.setToolTrackingClear(clearToolTracking);

  const sendGatewayCommand = async (command: string, args: string[] = []): Promise<string> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("ws://localhost:3456");
      let accumulatedText = "";
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        fn();
      };

      const timeout = setTimeout(() => {
        finish(() => reject(new Error("Gateway command timed out")));
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "command", command, args }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            data?: { content?: string; finalText?: string; message?: string };
          };

          if (msg.type === "text_delta") {
            accumulatedText += msg.data?.content ?? "";
            return;
          }

          if (msg.type === "done") {
            clearTimeout(timeout);
            const finalText = msg.data?.finalText ?? accumulatedText;
            finish(() => resolve(finalText || "(no response)"));
            return;
          }

          if (msg.type === "error") {
            clearTimeout(timeout);
            finish(() => reject(new Error(msg.data?.message || "Gateway command failed")));
            return;
          }
        } catch {
          // Ignore non-command frames
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        finish(() => reject(new Error("Failed to connect to Gateway")));
      };

      ws.onclose = () => {
        if (!settled) {
          clearTimeout(timeout);
          finish(() => reject(new Error("Gateway connection closed before command response")));
        }
      };
    });
  };

  const normalizeGatewayToolResult = (result: unknown, isError?: boolean) => {
    const normalizedError = isError ?? false;

    if (typeof result === "object" && result !== null) {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.content)) {
        return {
          content: r.content,
          details: {
            source: "gateway",
            ...(typeof r.details === "object" && r.details !== null ? r.details as Record<string, unknown> : {}),
          },
          isError: typeof r.isError === "boolean" ? r.isError : normalizedError,
        };
      }
    }

    const text = typeof result === "string"
      ? result
      : JSON.stringify(result ?? "", null, 2);

    return {
      content: [{ type: "text", text }],
      details: { source: "gateway", result },
      isError: normalizedError,
    };
  };

  // Listen for tool calls from Gateway provider
  pi.events.on("gateway:tool_call", (data: { id: string; name: string; arguments: unknown }) => {
    gatewayToolCallIds.add(data.id);
  });

  // Listen for final tool results from Gateway provider
  pi.events.on("gateway:tool_result", (data: { toolCallId: string; result: unknown; isError?: boolean }) => {
    pendingToolResults.set(data.toolCallId, { result: data.result, isError: data.isError });

    // Also resolve any waiters
    const waiters = toolResultWaiters.get(data.toolCallId);
    if (waiters) {
      for (const waiter of waiters) {
        waiter({ result: data.result, isError: data.isError });
      }
      toolResultWaiters.delete(data.toolCallId);
    }

  });

  // Intercept tool calls and inject Gateway results
  pi.on("tool_call", async (event) => {
    // Skip if we've already resolved this tool call (prevents double-handling)
    if (resolvedToolCallIds.has(event.toolCallId)) {
      console.log(`[GatewayBridge] Tool call ${event.toolCallId} already resolved, skipping`);
      return { block: false };
    }

    const pending = pendingToolResults.get(event.toolCallId);
    
    // Check if this is a Gateway-originated tool call
    if (gatewayToolCallIds.has(event.toolCallId) || pending) {
      // If we have a pending result, return it immediately
      if (pending) {
        pendingToolResults.delete(event.toolCallId); // Clear after use
        resolvedToolCallIds.add(event.toolCallId);    // Mark as resolved
        return {
          result: normalizeGatewayToolResult(pending.result, pending.isError),
        };
      }
      
      // If no result yet, wait for it (with timeout)
      return new Promise((resolve) => {
        // Set up waiter
        if (!toolResultWaiters.has(event.toolCallId)) {
          toolResultWaiters.set(event.toolCallId, []);
        }
        toolResultWaiters.get(event.toolCallId)!.push((result) => {
          pendingToolResults.delete(event.toolCallId);
          resolvedToolCallIds.add(event.toolCallId);  // Mark as resolved
          resolve({
            result: normalizeGatewayToolResult(result.result, result.isError),
          });
        });
        
        // Timeout after 30 seconds
        setTimeout(() => {
          if (toolResultWaiters.has(event.toolCallId)) {
            toolResultWaiters.delete(event.toolCallId);
            resolvedToolCallIds.add(event.toolCallId);  // Mark as resolved even on timeout
            resolve({
              result: {
                content: [{ type: "text", text: "[Gateway: Tool result timeout]" }],
                details: { error: "timeout" },
                isError: true,
              },
            });
          }
        }, 30000);
      });
    }
    
    // Let other tool calls through normally
    return { block: false };
  });
  
  pi.registerCommand("gw-model", {
    description: "Run gateway /model command (e.g. /gw-model list or /gw-model 3)",
    handler: async (args, ctx) => {
      try {
        const parts = args.trim() ? args.trim().split(/\s+/) : [];
        const result = await sendGatewayCommand("model", parts);
        ctx.ui.notify(result, "info");
      } catch (err) {
        ctx.ui.notify(`Gateway model command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("gw-session", {
    description: "Run gateway /session command",
    handler: async (_args, ctx) => {
      try {
        const result = await sendGatewayCommand("session", []);
        ctx.ui.notify(result, "info");
      } catch (err) {
        ctx.ui.notify(`Gateway session command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("gw-new", {
    description: "Run gateway /new command",
    handler: async (_args, ctx) => {
      try {
        const result = await sendGatewayCommand("new", []);
        ctx.ui.notify(result, "info");
      } catch (err) {
        ctx.ui.notify(`Gateway new command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("gw-status", {
    description: "Show gateway status/state",
    handler: async (_args, ctx) => {
      try {
        const result = await sendGatewayCommand("status", []);
        ctx.ui.notify(result, "info");
      } catch (err) {
        ctx.ui.notify(`Gateway status command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // Register the Gateway provider
  // Note: apiKey is required by Pi's provider registration, but not used
  // since we connect via WebSocket to Gateway
  pi.registerProvider("gateway", {
    baseUrl: "ws://localhost:3456",
    apiKey: "dummy", // Required by Pi but not used (WebSocket auth)
    api: "openai-completions" as any, // Use a compatible API type
    models: [
      {
        id: "bridge",
        name: "Gateway Bridge",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16384,
      },
    ],
    streamSimple: provider.stream.bind(provider),
  });

}
