// Pi RPC Command Types (sent to Pi via stdin)
export type PiCommand =
  | { type: "prompt"; message: string; id?: string }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  | { type: "get_messages"; id?: string };

// Pi RPC Response (received from Pi via stdout)
export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

// Pi RPC Event Types (streamed from Pi)
export type PiEvent =
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_end"; toolName: string; result: unknown }
  | { type: "agent_end" }
  | { type: "response"; id?: string; command: string; success: boolean };

export type AssistantMessageEvent =
  | { type: "text_delta"; delta: string }
  | { type: "text_done"; text: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_done" };

// Gateway internal types
export interface GatewayState {
  tuiActive: boolean;
  piRunning: boolean;
  pendingMessages: string[];
}
