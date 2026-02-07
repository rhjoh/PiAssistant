// Pi RPC Command Types (sent to Pi via stdin)
export type PiCommand =
  | { type: "prompt"; message: string; id?: string }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  | { type: "get_messages"; id?: string }
  | { type: "get_session_stats"; id?: string }
  | { type: "get_available_models"; id?: string }
  | { type: "set_model"; provider: string; modelId: string; id?: string }
  | { type: "new_session"; parentSession?: string; id?: string }
  | { type: "switch_session"; sessionPath: string; id?: string };

// Pi RPC Response (received from Pi via stdout)
export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

// Pi State from get_state response
export interface PiState {
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionFile: string;
  sessionId: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

// Pi RPC Event Types (streamed from Pi)
export type PiEvent =
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "tool_execution_start"; toolName: string }
  | { type: "tool_execution_end"; toolName: string; result: unknown }
  | { type: "agent_end" }
  | { type: "response"; id?: string; command: string; success: boolean }
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | { type: "auto_compaction_end"; result: CompactionResult | null; aborted: boolean; willRetry: boolean };

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

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
