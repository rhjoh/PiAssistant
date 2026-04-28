/**
 * WebSocket message types for Gateway <-> Client communication
 */

// Client → Gateway
export type WSClientMessage =
  | { type: "prompt"; message: string; id?: string }
  | { type: "prompt_with_images"; message: string; images: WSImageAttachment[]; id?: string }
  | { type: "tool_call"; call_id: string; name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; call_id: string; name: string; ok: boolean; data: unknown }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "get_history"; limit?: number }
  | { type: "get_models" }
  | { type: "switch_model"; provider: string; modelId: string }
  | { type: "command"; command: string; args?: string[] }
  | { type: "ping"; timestamp?: number };

export interface WSImageAttachment {
  data: string; // base64 encoded
  mimeType: string; // e.g., "image/png", "image/jpeg"
}

// Gateway → Client
export type WSServerMessage =
  | { type: "connection"; data: WSConnectionData }
  | { type: "user_message"; data: { content: string; source: string } }
  | { type: "text_delta"; data: { content: string } }
  | { type: "thinking_delta"; data: { thinkingId: string; content: string; seq: number } }
  | { type: "thinking_done"; data: { thinkingId: string; content: string; seq: number } }
  | {
      type: "tool_start";
      data: { toolCallId: string; toolName: string; args?: unknown; label: string };
    }
  | { type: "tool_output"; data: { toolCallId: string; output: string; truncated?: boolean } }
  | { type: "tool_end"; data: { toolCallId: string; toolName: string } }
  | { type: "image"; data: { source: string; alt?: string } }
  | { type: "error"; data: { message: string } }
  | { type: "proactive"; data: { message: string } }
  | { type: "done"; data: { finalText: string; usage?: TokenUsage } }
  | { type: "usage"; data: TokenUsage }
  | { type: "state"; data: WSStateData }
  | { type: "history"; data: { messages: unknown[] } }
  | { type: "models"; data: { models: WSModelInfo[]; current?: WSModelInfo } }
  | { type: "model_switched"; data: { success: boolean; model?: WSModelInfo; error?: string } }
  | { type: "pong"; data: { timestamp: number } }
  | { type: "ping" }
  | {
      type: "tool_call";
      call_id: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      call_id: string;
      name: string;
      ok: boolean;
      data: unknown;
    };

export interface WSModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface WSConnectionData {
  connected: true;
  model?: WSModelInfo;
  contextWindow?: number;
}

export interface WSStateData {
  model?: WSModelInfo;
  contextWindow?: number;
  contextTokens?: number;
  isProcessing: boolean;
  /** Cumulative session token usage */
  sessionUsage?: TokenUsage;
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
