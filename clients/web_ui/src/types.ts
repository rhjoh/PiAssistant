export type MessageContent = 
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; thinkingId?: string; seq?: number }
  | { type: 'tool_call'; id: string; name: string; args?: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'image'; url: string; alt?: string };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | MessageContent[];
  turnId?: string;
  isStreaming?: boolean;
  timestamp?: number;
  tokenUsage?: TokenUsage;
  images?: string[]; // Data URLs or local file server URLs for user uploads/history
}

export interface WSMessage {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface SessionStats {
  currentContextTokens: number;
  lastTurnTokens: number;
  lastInput: number;
  lastOutput: number;
  lastCacheRead: number;
  lastCost: number;
  messageCount: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface UploadImage {
  dataUrl: string;
  mimeType: string;
  size: number;
}

export const COMMANDS = [
  { name: '/new', desc: 'Start a new session' },
  { name: '/model', desc: 'Switch model' },
  { name: '/session', desc: 'Show session stats' },
  { name: '/status', desc: 'Show gateway status' },
  { name: '/clear', desc: 'Clear the chat view' },
];
