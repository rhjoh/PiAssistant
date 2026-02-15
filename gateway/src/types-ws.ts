/**
 * WebSocket message types for Gateway <-> Client communication
 */

// Client → Gateway
export type WSClientMessage =
  | { type: "prompt"; message: string; id?: string }
  | { type: "prompt_with_images"; message: string; images: WSImageAttachment[]; id?: string }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "get_history"; limit?: number }
  | { type: "command"; command: string; args?: string[] };

export interface WSImageAttachment {
  data: string; // base64 encoded
  mimeType: string; // e.g., "image/png", "image/jpeg"
}

// Gateway → Client
export type WSServerMessage =
  | { type: "connection"; data: WSConnectionData }
  | { type: "text_delta"; data: { content: string } }
  | { type: "thinking_delta"; data: { content: string } }
  | { type: "thinking_done"; data: { content: string } }
  | { type: "tool_start"; data: { toolCallId: string; toolName: string; args?: unknown; label: string } }
  | { type: "tool_output"; data: { toolCallId: string; output: string; truncated?: boolean } }
  | { type: "tool_end"; data: { toolCallId: string; toolName: string } }
  | { type: "image"; data: { source: string; alt?: string } }
  | { type: "error"; data: { message: string } }
  | { type: "proactive"; data: { message: string } }
  | { type: "done"; data: { finalText: string; usage?: TokenUsage } }
  | { type: "usage"; data: TokenUsage }
  | { type: "state"; data: WSStateData }
  | { type: "history"; data: { messages: unknown[] } }
  | { type: "ping" };

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
 * Client interface for broadcasting - abstracts Telegram and WebSocket clients
 */
export interface Client {
  id: string;
  type: "telegram" | "websocket";
  send(message: WSServerMessage): Promise<void> | void;
  isAvailable(): boolean;
}
