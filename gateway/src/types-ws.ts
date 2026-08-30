/**
 * WebSocket message types for Gateway <-> Client communication
 */

/**
 * How a prompt submitted while the assistant is processing is delivered:
 * - "steer": queued by Pi and delivered after the current assistant turn and
 *   its tool batch, before the next LLM call.
 * - "followUp": queued by Pi and delivered only after the agent would
 *   otherwise finish.
 */
export type StreamingBehavior = "steer" | "followUp";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Client → Gateway
export type WSClientMessage =
  | { type: "prompt"; message: string; id?: string; streamingBehavior?: StreamingBehavior }
  | {
      type: "prompt_with_images";
      message: string;
      images: WSImageAttachment[];
      id?: string;
      streamingBehavior?: StreamingBehavior;
    }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "get_history"; limit?: number }
  | { type: "get_models" }
  | { type: "switch_model"; provider: string; modelId: string }
  | { type: "get_thinking_levels" }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "command"; command: string; args?: string[] }
  | { type: "ping"; timestamp?: number }
  | WSExtensionUiResponse;

export interface WSImageAttachment {
  data: string; // base64 encoded
  mimeType: string; // e.g., "image/png", "image/jpeg"
}

export interface WSTaskMetadata {
  turnId?: string;
  originClientId?: string;
  origin?: "task";
  taskId?: string;
  taskRunId?: string;
  taskName?: string;
}

/** A user message accepted by the gateway while an assistant run is active. */
export interface QueuedPrompt {
  id: string;
  content: string;
  behavior: StreamingBehavior;
  originClientId: string;
}

/** A root prompt accepted by the gateway for immediate execution. */
export interface AcceptedPrompt {
  id: string;
  content: string;
  originClientId: string;
}

// Gateway → Client
export type WSServerMessage =
  | { type: "connection"; data: WSConnectionData }
  | { type: "user_message"; data: { content: string; source: string; id?: string } & WSTaskMetadata }
  | { type: "text_delta"; data: { content: string } & WSTaskMetadata }
  | { type: "thinking_delta"; data: { thinkingId: string; content: string; seq: number } & WSTaskMetadata }
  | { type: "thinking_done"; data: { thinkingId: string; content: string; seq: number } & WSTaskMetadata }
  | {
      type: "tool_start";
      data: { toolCallId: string; toolName: string; args?: unknown; label: string } & WSTaskMetadata;
    }
  | { type: "tool_output"; data: { toolCallId: string; output: string; truncated?: boolean } & WSTaskMetadata }
  | { type: "tool_end"; data: { toolCallId: string; toolName: string; isError: boolean } & WSTaskMetadata }
  | { type: "image"; data: { source: string; alt?: string } & WSTaskMetadata }
  | { type: "error"; data: { message: string } & WSTaskMetadata }
  | { type: "proactive"; data: { message: string } }
  | { type: "notify"; data: { message: string; notifyType?: "info" | "warning" | "error" } }
  | {
      type: "extension_error";
      data: { message: string; extensionPath?: string; event?: string };
    }
  | { type: "extension_ui_request"; data: WSExtensionUiRequest }
  | { type: "extension_ui_resolved"; data: { id: string; cancelled?: boolean } }
  /**
   * A logical assistant response segment (one turn) has finished, but the
   * session-level run is still active (more queued work follows). Emitted
   * before a consumed queued user message is broadcast.
   */
  | { type: "response_segment_done"; data: { finalText?: string; usage?: TokenUsage } & WSTaskMetadata }
  /** Acknowledgement to the submitting client that a root prompt was accepted. */
  | { type: "prompt_accepted"; data: AcceptedPrompt }
  /** Acknowledgement to the submitting client that Pi accepted a busy-time prompt. */
  | { type: "prompt_queued"; data: QueuedPrompt }
  /** Pending steering/follow-up queues changed. Broadcast to all clients. */
  | { type: "queue_update"; data: { steering: QueuedPrompt[]; followUp: QueuedPrompt[] } }
  /** Abort finished and the gateway is ready to accept another prompt. */
  | { type: "abort_complete"; data: { forced: boolean; restarted: boolean; message: string } }
  | { type: "done"; data: { finalText: string; usage?: TokenUsage } & WSTaskMetadata }
  | { type: "usage"; data: TokenUsage }
  | { type: "state"; data: WSStateData }
  | { type: "history"; data: { messages: unknown[] } }
  | { type: "models"; data: { models: WSModelInfo[]; current?: WSModelInfo } }
  | { type: "model_switched"; data: { success: boolean; model?: WSModelInfo; error?: string } }
  | {
      type: "thinking_levels";
      data: { levels: ThinkingLevel[]; current: ThinkingLevel; model?: WSModelInfo };
    }
  | {
      type: "thinking_level_changed";
      data: {
        success: boolean;
        requestedLevel: ThinkingLevel;
        level?: ThinkingLevel;
        availableLevels?: ThinkingLevel[];
        model?: WSModelInfo;
        error?: string;
      };
    }
  | { type: "pong"; data: { timestamp: number } }
  | { type: "ping" };

export interface WSModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

export type WSWorkingKind = "compaction" | "retry" | "extension_ui" | "status";

export interface WSWorkingStatus {
  kind: WSWorkingKind;
  message: string;
}

export type WSExtensionUiRequest = {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
};

export type WSExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface WSConnectionData extends WSStateData {
  connected: true;
}

export interface WSStateData {
  model?: WSModelInfo;
  contextWindow?: number;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
  isProcessing: boolean;
  /** Cumulative session token usage */
  sessionUsage?: TokenUsage;
  /** Pi session id; clients clear local transcripts when this changes. */
  sessionId?: string;
  isCompacting?: boolean;
  /** Human-readable live activity (compaction, retry, waiting for input). */
  working?: WSWorkingStatus | null;
  /** Blocking extension UI dialog currently waiting for an answer, if any. */
  pendingExtensionUi?: WSExtensionUiRequest | null;
  /** Fire-and-forget widget lines from Pi extensions. */
  widgets?: string[] | null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
  /** Cumulative session totals (present in done message, includes all turns) */
  cumulative?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost?: number;
  };
  /** Current context size estimate (cacheRead + input from this turn) */
  contextTokens?: number;
}

/**
 * Client interface for broadcasting - abstracts Telegram and WebSocket clients
 */
export interface Client {
  id: string;
  type: "telegram" | "websocket";
  send(message: WSServerMessage): Promise<void> | void;
  isAvailable(): boolean;
}
