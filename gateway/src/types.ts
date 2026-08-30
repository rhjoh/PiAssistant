/**
 * How a `prompt` sent while the agent is already streaming is delivered:
 * - "steer": queued and delivered after the current assistant turn and its
 *   tool batch, before the next LLM call.
 * - "followUp": queued and delivered only after the agent would otherwise finish.
 */
export type StreamingBehavior = "steer" | "followUp";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  contextWindow?: number;
  [key: string]: unknown;
}

// Pi RPC Command Types (sent to Pi via stdin)
export type PiCommand =
  | {
      type: "prompt";
      message: string;
      images?: ImageContent[];
      id?: string;
      streamingBehavior?: StreamingBehavior;
    }
  | { type: "steer"; message: string; images?: ImageContent[]; id?: string }
  | { type: "follow_up"; message: string; images?: ImageContent[]; id?: string }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  | { type: "get_messages"; id?: string }
  | { type: "get_session_stats"; id?: string }
  | { type: "get_available_models"; id?: string }
  | { type: "get_available_thinking_levels"; id?: string }
  | { type: "set_model"; provider: string; modelId: string; id?: string }
  | { type: "set_thinking_level"; level: ThinkingLevel; id?: string }
  | { type: "new_session"; parentSession?: string; id?: string }
  | { type: "switch_session"; sessionPath: string; id?: string }
  | PiExtensionUiResponse;

// Image content for Pi RPC (see docs/rpc.md)
export interface ImageContent {
  type: "image";
  data: string; // base64 encoded
  mimeType: string;
}

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
  model: PiModelInfo | null;
  thinkingLevel: ThinkingLevel;
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

// Token usage from assistant messages
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

// Assistant message in agent_end events
export interface AssistantMessage {
  role: "assistant";
  content: unknown[];
  usage?: TokenUsage;
  [key: string]: unknown;
}

// Pi RPC Event Types (streamed from Pi)
export type PiEvent =
  // Agent lifecycle. agent_end is one low-level run; agent_settled is the
  // authoritative idle boundary (no retry/compaction/queued continuation left).
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: AssistantMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  // Turn lifecycle - a turn is one assistant response + any tool calls/results.
  | { type: "turn_start" }
  | { type: "turn_end"; message?: PiAgentMessage; toolResults?: PiAgentMessage[] }
  // Message lifecycle - emitted for user, assistant, and toolResult messages.
  | { type: "message_start"; message: PiAgentMessage }
  | { type: "message_end"; message: PiAgentMessage }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  // Pending steering/follow-up queue changed (texts only, no client IDs).
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  // Tool execution events (Pi RPC schema, see pi-coding-agent docs/rpc.md)
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; args?: unknown }
  // Direct bash command output chunks (id matches the bash command's id).
  | { type: "bash_execution_update"; id: string; delta: string }
  // Compaction (installed Pi emits compaction_start/compaction_end).
  | { type: "compaction_start"; reason: string }
  | {
      type: "compaction_end";
      reason?: string;
      result: CompactionResult | null;
      aborted: boolean;
      willRetry?: boolean;
    }
  // Retry events.
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end"; success: boolean }
  | { type: "summarization_retry_scheduled" }
  | { type: "summarization_retry_attempt_start" }
  | { type: "summarization_retry_finished"; success?: boolean }
  // Legacy compaction event names (older Pi versions).
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | { type: "auto_compaction_end"; result: CompactionResult | null; aborted: boolean; willRetry: boolean }
  | { type: "response"; id?: string; command: string; success: boolean }
  | PiExtensionUiRequest
  | {
      type: "extension_error";
      extensionPath?: string;
      event?: string;
      error: string;
    };

/** Pi RPC extension UI request (stdout). Dialog methods block until a response. */
export type PiExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    };

/** Client → Pi response for a blocking extension UI dialog. */
export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export const EXTENSION_UI_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type ExtensionUiDialogMethod = (typeof EXTENSION_UI_DIALOG_METHODS)[number];

export function isExtensionUiDialogMethod(method: string): method is ExtensionUiDialogMethod {
  return (EXTENSION_UI_DIALOG_METHODS as readonly string[]).includes(method);
}

/** An LLM/agent message as carried by message_start/message_end/turn_end events. */
export interface PiAgentMessage {
  role: string;
  content: unknown;
  timestamp?: number;
  usage?: TokenUsage;
  [key: string]: unknown;
}

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
