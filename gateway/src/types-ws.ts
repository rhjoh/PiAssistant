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
  | { type: "thinking_delta"; data: { content: string } }
  | { type: "thinking_done"; data: { content: string } }
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
  model?: string;
  provider?: string;
}

export interface WSStateData {
  model?: string;
  provider?: string;
  contextTokens?: number;
  isProcessing: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

/**
 * Dedicated /pi-client native stream contract.
 * This is intentionally separate from generic WSServerMessage events.
 */
export type PiClientNativeEvent =
  | { type: "turn_start"; turnId: string; seq: number }
  | { type: "text_delta"; turnId: string; seq: number; text: string }
  | { type: "text_done"; turnId: string; seq: number; text: string }
  | { type: "thinking"; turnId: string; seq: number; text: string }
  | { type: "thinking_done"; turnId: string; seq: number }
  | {
      type: "tool_execution_start";
      turnId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      turnId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      turnId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
      args?: Record<string, unknown>;
    }
  | { type: "image"; turnId: string; seq: number; data: string; mimeType: string }
  | { type: "done"; turnId: string; seq: number }
  | {
      type: "turn_end";
      turnId: string;
      seq: number;
      stopReason: "stop" | "toolUse" | "error" | "aborted";
    }
  | { type: "error"; turnId: string; seq: number; message: string };

/**
 * Client interface for broadcasting - abstracts Telegram and WebSocket clients
 */
export interface Client {
  id: string;
  type: "telegram" | "websocket";
  send(message: WSServerMessage): Promise<void> | void;
  isAvailable(): boolean;
}
