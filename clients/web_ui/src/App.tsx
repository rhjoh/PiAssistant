import { useState, useEffect, useRef, useCallback } from 'react';
import { StatusBar } from '@/components/StatusBar';
import { Sidebar } from '@/components/Sidebar';
import { MessageFeed } from '@/components/MessageFeed';
import { InputArea } from '@/components/InputArea';
import { DebugPanel } from '@/components/DebugPanel';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ChatMessage, WSMessage, SessionStats, MessageContent, TokenUsage, ModelInfo, UploadImage } from '@/types';

const WS_URL = 'ws://localhost:3456';

function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'OPS-';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// Helper to check if a message is heartbeat-related
function isHeartbeatMessage(content: string | MessageContent[]): boolean {
  const text = typeof content === 'string' 
    ? content 
    : content.map(c => c.type === 'text' ? c.content : '').join('');
  const trimmed = text.trim().replace(/^`+|`+$/g, '');
  // Heartbeat user messages start with "[Heartbeat]"
  // Heartbeat assistant responses contain "[[NO_ACTION]]"
  return trimmed.startsWith('[Heartbeat]') || trimmed.includes('[[NO_ACTION]]');
}

function imageSourceToUrl(source?: string): string | undefined {
  if (!source) return undefined;
  if (source.startsWith('data:') || source.startsWith('http://') || source.startsWith('https://')) {
    return source;
  }
  return `http://localhost:3457/files/${encodeURIComponent(source)}`;
}

function dataUrlToAttachment(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, data] = match;
  return { mimeType, data };
}

function normalizeTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    totalTokens?: number;
    cost?: number | { total?: number };
  };

  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const total = u.total ?? u.totalTokens ?? (input + output + cacheRead + cacheWrite);
  const cost = typeof u.cost === 'number' ? u.cost : u.cost?.total;

  return { input, output, cacheRead, cacheWrite, total, cost };
}

function mergeHistoryMessages(prev: ChatMessage[], loaded: ChatMessage[]): ChatMessage[] {
  const mergedById = new Map<string, ChatMessage>();

  // History is authoritative for persisted rows.
  for (const msg of loaded) {
    mergedById.set(msg.id, msg);
  }

  // Preserve local-only streaming rows so reconnect history doesn't clobber active UI state.
  for (const msg of prev) {
    if (!mergedById.has(msg.id) && msg.isStreaming) {
      mergedById.set(msg.id, msg);
    }
  }

  return Array.from(mergedById.values()).sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
  );
}

function findLatestStreamingAssistantId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.isStreaming) return m.id;
  }
  return null;
}

export default function App() {

  const [sessionId] = useState(() => generateSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [debugMessages, setDebugMessages] = useState<Array<{type: string; timestamp: number; data?: unknown}>>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | undefined>();
  const streamingIdRef = useRef<string | null>(null);
  const skippedHeartbeatRef = useRef<boolean>(false);
  const hasHydratedHistoryRef = useRef<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleMessage = useCallback((msg: WSMessage) => {
    setDebugMessages(prev => [...prev.slice(-49), { 
      type: msg.type, 
      timestamp: Date.now(),
      data: msg.data 
    }]);

    switch (msg.type) {
      case 'history': {
        const historyData = msg.data as { messages: Array<{id: string; role: string; content: unknown; timestamp: number; toolCallId?: string; toolName?: string; isError?: boolean; usage?: unknown}> };
        const loadedMessages: ChatMessage[] = [];
        
        // Helper to convert session content part to MessageContent
        const convertContentPart = (part: unknown): MessageContent => {
          if (typeof part === 'string') {
            return { type: 'text', content: part };
          }
          if (typeof part === 'object' && part !== null) {
            const p = part as {type?: string; content?: unknown; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown>; toolCallId?: string; isError?: boolean; path?: string; source?: string; alt?: string};
            
            if (p.type === 'text') {
              return { type: 'text', content: p.text || p.content as string || '' };
            }
            if (p.type === 'thinking') {
              return { type: 'thinking', content: p.thinking || p.content as string || '' };
            }
            if (p.type === 'toolCall') {
              return { type: 'tool_call', id: p.id || '', name: p.name || '', args: p.arguments };
            }
            if (p.type === 'tool_result') {
              return { type: 'tool_result', toolCallId: p.toolCallId || '', content: p.content as string || '', isError: p.isError };
            }
            if (p.type === 'image') {
              const imageUrl = imageSourceToUrl(p.source || p.path);
              if (imageUrl) {
                return { type: 'image', url: imageUrl, alt: p.alt };
              }
            }
          }
          return { type: 'text', content: String(part) };
        };
        
        // Process messages and group tool results with their assistant messages
        for (let i = 0; i < historyData.messages.length; i++) {
          const m = historyData.messages[i];
          const baseMsg = {
            id: m.id || `hist-${i}`,
            timestamp: m.timestamp || Date.now(),
          };
          
          if (m.role === 'user') {
            // Extract text content from user message array
            let textContent = '';
            const userImages: string[] = [];
            if (typeof m.content === 'string') {
              textContent = m.content;
            } else if (Array.isArray(m.content)) {
              textContent = m.content
                .map((part: unknown) => {
                  if (typeof part === 'string') return part;
                  if (typeof part === 'object' && part !== null) {
                    const p = part as {type?: string; text?: string; content?: string; path?: string; source?: string};
                    if (p.type === 'text') return p.text || p.content || '';
                    if (p.type === 'image') {
                      const imageUrl = imageSourceToUrl(p.source || p.path);
                      if (imageUrl) userImages.push(imageUrl);
                    }
                  }
                  return '';
                })
                .join('');
            } else {
              textContent = JSON.stringify(m.content);
            }
            
            // Skip heartbeat messages
            if (isHeartbeatMessage(textContent)) {
              continue;
            }
            
            loadedMessages.push({
              ...baseMsg,
              role: 'user' as const,
              content: textContent,
              images: userImages.length > 0 ? userImages : undefined,
            });
            continue;
          }
          
          if (m.role === 'assistant') {
            let content: MessageContent[] = [];
            if (Array.isArray(m.content)) {
              content = m.content.map(convertContentPart);
            } else if (typeof m.content === 'string') {
              content = [{ type: 'text', content: m.content }];
            }
            
            // Look ahead for tool results that belong to this assistant message
            // (tool results that come immediately after and have matching toolCallId)
            const toolResults: MessageContent[] = [];
            let j = i + 1;
            while (j < historyData.messages.length && historyData.messages[j].role === 'toolResult') {
              const tr = historyData.messages[j];
              // Extract text content from tool result array
              let textContent = '';
              if (typeof tr.content === 'string') {
                textContent = tr.content;
              } else if (Array.isArray(tr.content)) {
                textContent = tr.content
                  .map((part: unknown) => {
                    if (typeof part === 'string') return part;
                    if (typeof part === 'object' && part !== null) {
                      const p = part as {type?: string; text?: string; content?: string};
                      if (p.type === 'text') return p.text || p.content || '';
                    }
                    return String(part);
                  })
                  .join('');
              } else {
                textContent = JSON.stringify(tr.content);
              }
              
              toolResults.push({
                type: 'tool_result',
                toolCallId: tr.toolCallId || '',
                content: textContent,
                isError: tr.isError,
              });
              j++;
            }
            
            // Skip the tool result messages we just consumed
            if (toolResults.length > 0) {
              i = j - 1;
              content = [...content, ...toolResults];
            }
            
            // Skip heartbeat responses (assistant replying with just [[NO_ACTION]])
            if (isHeartbeatMessage(content)) {
              continue;
            }
            
            loadedMessages.push({
              ...baseMsg,
              role: 'assistant' as const,
              content,
              isStreaming: false,
              tokenUsage: normalizeTokenUsage(m.usage),
            });
            continue;
          }
          
          // Skip toolResult messages (they're grouped with assistant)
          if (m.role === 'toolResult') {
            continue;
          }
          
          // Fallback for other roles
          let fallbackContent = '';
          if (typeof m.content === 'string') {
            fallbackContent = m.content;
          } else if (Array.isArray(m.content)) {
            fallbackContent = m.content
              .map((part: unknown) => {
                if (typeof part === 'string') return part;
                if (typeof part === 'object' && part !== null) {
                  const p = part as { type?: string; text?: string; content?: string };
                  if (p.type === 'text') return p.text || p.content || '';
                }
                return String(part);
              })
              .join('');
          } else {
            fallbackContent = JSON.stringify(m.content);
          }
          loadedMessages.push({
            ...baseMsg,
            role: 'system' as const,
            content: fallbackContent,
          });
        }
        
        // Merge consecutive assistant messages from the session file.
        // Pi stores post-tool text as a separate assistant entry,
        // so [thinking, toolCall] and [text] end up as two ChatMessages.
        // Merge any consecutive assistant entries (real turns are separated by user messages).
        const merged: ChatMessage[] = [];
        for (const msg of loadedMessages) {
          const prev = merged[merged.length - 1];
          if (prev && msg.role === 'assistant' && prev.role === 'assistant') {
            const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: 'text', content: prev.content }];
            const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', content: msg.content }];
            prev.content = [...prevContent, ...msgContent] as MessageContent[];
            // Take the token usage from whichever entry has it (usually the last one in the turn)
            if (msg.tokenUsage) prev.tokenUsage = msg.tokenUsage;
          } else {
            merged.push(msg);
          }
        }

        setMessages(prev => {
          let next: ChatMessage[];
          if (!hasHydratedHistoryRef.current || prev.length === 0) {
            hasHydratedHistoryRef.current = true;
            next = merged;
          } else {
            hasHydratedHistoryRef.current = true;
            next = mergeHistoryMessages(prev, merged);
          }

          // Rebind stream target after hydration/merge to avoid stale refs.
          streamingIdRef.current = findLatestStreamingAssistantId(next);
          setIsProcessing(streamingIdRef.current !== null);
          return next;
        });
        break;
      }

      case 'text_delta': {
        const content = (msg.data as { content: string }).content;

        // Skip heartbeat response content entirely
        const trimmed = content.trim();
        if (trimmed.includes('[[NO_ACTION]]') || trimmed.startsWith('[Heartbeat]')) {
          break;
        }

        // If we skipped a heartbeat, force create a new message to avoid polluting active turn
        if (skippedHeartbeatRef.current && !streamingIdRef.current) {
          const newId = `ai-${Date.now()}-stream`;
          streamingIdRef.current = newId;
          setMessages(prev => [...prev, {
            id: newId,
            role: 'assistant' as const,
            content: [{ type: 'text' as const, content }],
            isStreaming: true,
            timestamp: Date.now()
          }]);
          break;
        }

        // If we skipped a heartbeat and there's an active message, DON'T append to it
        if (skippedHeartbeatRef.current && streamingIdRef.current) {
          break;
        }

        setMessages(prev => {
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;

          // No streaming message found - create one
          if (!targetMsg) {
            const newId = `ai-${Date.now()}-stream`;
            streamingIdRef.current = newId;
            return [...prev, {
              id: newId,
              role: 'assistant' as const,
              content: [{ type: 'text' as const, content }],
              isStreaming: true,
              timestamp: Date.now()
            }];
          }

          // Update existing message
          return prev.map(m => {
            if (m.id !== targetId) return m;
            const contents = Array.isArray(m.content) ? m.content : [];
            const lastIdx = contents.length - 1;
            if (lastIdx >= 0 && contents[lastIdx].type === 'text') {
              return {
                ...m,
                content: [
                  ...contents.slice(0, lastIdx),
                  { type: 'text' as const, content: (contents[lastIdx] as {type: 'text'; content: string}).content + content }
                ]
              };
            }
            return { ...m, content: [...contents, { type: 'text', content }] };
          });
        });
        break;
      }

      case 'thinking_delta': {
        const content = (msg.data as { content: string }).content;

        // Skip heartbeat response content entirely
        const trimmedThinking = content.trim();
        if (trimmedThinking.includes('[[NO_ACTION]]') || trimmedThinking.startsWith('[Heartbeat]')) {
          break;
        }

        // If we skipped a heartbeat and there's an active message, DON'T append to it
        if (skippedHeartbeatRef.current && streamingIdRef.current) {
          break;
        }

        setIsProcessing(true);

        setMessages(prev => {
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          // No streaming message found - create one
          if (!targetMsg) {
            const newId = `ai-${Date.now()}-stream`;
            streamingIdRef.current = newId;
            return [...prev, {
              id: newId,
              role: 'assistant' as const,
              content: [{ type: 'thinking' as const, content }],
              isStreaming: true,
              timestamp: Date.now()
            }];
          }
          
          // Update existing message
          return prev.map(m => {
            if (m.id !== targetId) return m;
            const contents = Array.isArray(m.content) ? m.content : [];
            const lastIdx = contents.length - 1;
            if (lastIdx >= 0 && contents[lastIdx].type === 'thinking') {
              return { 
                ...m, 
                content: [
                  ...contents.slice(0, lastIdx),
                  { type: 'thinking' as const, content: (contents[lastIdx] as {type: 'thinking'; content: string}).content + content }
                ]
              };
            }
            return { ...m, content: [...contents, { type: 'thinking', content }] };
          });
        });
        break;
      }

      case 'thinking_done':
        // Keep processing state during tool calls
        break;

      case 'tool_start': {
        const data = msg.data as { toolCallId: string; toolName: string; args?: unknown };
        
        setMessages(prev => {
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          // No streaming message found - create one
          if (!targetMsg) {
            const newId = `ai-${Date.now()}-stream`;
            streamingIdRef.current = newId;
            return [...prev, {
              id: newId,
              role: 'assistant' as const,
              content: [{
                type: 'tool_call' as const,
                id: data.toolCallId,
                name: data.toolName,
                args: typeof data.args === 'object' && data.args !== null ? data.args as Record<string, unknown> : undefined
              }],
              isStreaming: true,
              timestamp: Date.now()
            }];
          }
          
          // Update existing message
          return prev.map(m => {
            if (m.id !== targetId) return m;
            const contents = Array.isArray(m.content) ? m.content : [];
            return {
              ...m,
              content: [...contents, {
                type: 'tool_call' as const,
                id: data.toolCallId,
                name: data.toolName,
                args: typeof data.args === 'object' && data.args !== null ? data.args as Record<string, unknown> : undefined
              }]
            };
          });
        });
        break;
      }

      case 'tool_output': {
        const data = msg.data as { toolCallId: string; output: string; truncated?: boolean };
        const resultContent = data.truncated ? data.output + '\n... (truncated)' : data.output;
        
        setMessages(prev => {
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          // No streaming message found - create one
          if (!targetMsg) {
            const newId = `ai-${Date.now()}-stream`;
            streamingIdRef.current = newId;
            return [...prev, {
              id: newId,
              role: 'assistant' as const,
              content: [{ type: 'tool_result' as const, toolCallId: data.toolCallId, content: resultContent }],
              isStreaming: true,
              timestamp: Date.now()
            }];
          }
          
          // Update existing message
          return prev.map(m => {
            if (m.id !== targetId) return m;
            const contents = Array.isArray(m.content) ? m.content : [];
            const existingIdx = contents.findIndex(c => c.type === 'tool_result' && (c as {toolCallId: string}).toolCallId === data.toolCallId);
            
            if (existingIdx >= 0) {
              return {
                ...m,
                content: [
                  ...contents.slice(0, existingIdx),
                  { type: 'tool_result', toolCallId: data.toolCallId, content: resultContent },
                  ...contents.slice(existingIdx + 1)
                ]
              };
            }
            return {
              ...m,
              content: [...contents, { type: 'tool_result' as const, toolCallId: data.toolCallId, content: resultContent }]
            };
          });
        });
        break;
      }

      case 'image': {
        const data = msg.data as { source: string; alt?: string };
        const imageUrl = imageSourceToUrl(data.source);
        if (!imageUrl) break;

        setMessages(prev => {
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;

          if (!targetMsg || !targetId) {
            const newId = `ai-${Date.now()}-stream`;
            streamingIdRef.current = newId;
            return [...prev, {
              id: newId,
              role: 'assistant' as const,
              content: [{ type: 'image' as const, url: imageUrl, alt: data.alt }],
              isStreaming: true,
              timestamp: Date.now(),
            }];
          }

          return prev.map(m => {
            if (m.id !== targetId) return m;
            const contents = Array.isArray(m.content) ? m.content : [];
            return {
              ...m,
              content: [...contents, { type: 'image' as const, url: imageUrl, alt: data.alt }],
            };
          });
        });
        break;
      }

      case 'done': {
        setIsProcessing(false);
        const doneData = msg.data as {
          finalText?: string;
          usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number };
        } | undefined;
        const finalText = doneData?.finalText?.trim();
        const normalizedFinalText = finalText?.replace(/^`+|`+$/g, '');
        let currentId = streamingIdRef.current;
        if (currentId) {
          setMessages(prev => {
            const activeExists = prev.some(m => m.id === currentId && m.role === 'assistant' && m.isStreaming);
            if (!activeExists) return prev;

            const targetMsg = prev.find(m => m.id === currentId);
            // Filter out heartbeat responses
            if ((targetMsg && isHeartbeatMessage(targetMsg.content)) || (normalizedFinalText && isHeartbeatMessage(normalizedFinalText))) {
              return prev.filter(m => m.id !== currentId);
            }
            return prev.map(m =>
              m.id === currentId
                ? (() => {
                    const currentContent = Array.isArray(m.content) ? m.content : [];
                    let mergedContent = currentContent;

                    if (normalizedFinalText) {
                      // Consolidate all text blocks into one to avoid duplicates.
                      // Tool calls/thinking can split streamed text into multiple blocks;
                      // done.finalText is the single authoritative text.
                      const textBlock = { type: 'text' as const, content: normalizedFinalText };
                      let textInserted = false;
                      mergedContent = currentContent.map(part => {
                        if (part.type === 'text') {
                          if (!textInserted) {
                            textInserted = true;
                            return textBlock;
                          }
                          return null; // remove duplicate text blocks
                        }
                        return part;
                      }).filter((part): part is MessageContent => part !== null);
                    }

                    return {
                      ...m,
                      content: mergedContent,
                      isStreaming: false,
                      tokenUsage: normalizeTokenUsage(doneData?.usage),
                    };
                  })()
                : m
            );
          });
          streamingIdRef.current = null;
        } else {
          if (normalizedFinalText) {
            setMessages(prev => [...prev, {
              id: `ai-${Date.now()}`,
              role: 'assistant',
              content: [{ type: 'text' as const, content: normalizedFinalText }],
              isStreaming: false,
              tokenUsage: normalizeTokenUsage(doneData?.usage),
              timestamp: Date.now(),
            }]);
          }
        }
        // Reset heartbeat skip flag after processing done
        streamingIdRef.current = null;
        skippedHeartbeatRef.current = false;
        break;
      }

      case 'error': {
        const errorMsg = (msg.data as { message: string }).message;
        setIsProcessing(false);
        streamingIdRef.current = null;
        skippedHeartbeatRef.current = false;
        setMessages(prev => [...prev, {
          id: `sys-${Date.now()}`,
          role: 'system',
          content: `ERROR: ${errorMsg}`,
          timestamp: Date.now()
        }]);
        break;
      }

      case 'proactive': {
        const proactiveMsg = (msg.data as { message: string }).message;
        if (isHeartbeatMessage(proactiveMsg)) {
          break;
        }
        setMessages(prev => [...prev, {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: proactiveMsg,
          timestamp: Date.now()
        }]);
        break;
      }

      case 'user_message': {
        const userData = msg.data as { content: string; source: string };

        // Skip heartbeat messages
        if (isHeartbeatMessage(userData.content)) {
          // Set flag to skip subsequent assistant response (prevents doubled words bug)
          skippedHeartbeatRef.current = true;
          break;
        }
        
        const userMsgId = `usr-${Date.now()}`;
        const aiMsgId = `ai-${Date.now()}-stream`;
        
        // Set streaming ID BEFORE state update to catch any early deltas
        streamingIdRef.current = aiMsgId;
        setIsProcessing(true);
        
        // Single atomic update for both user message and assistant placeholder
        setMessages(prev => [...prev, 
          {
            id: userMsgId,
            role: 'user',
            content: userData.content,
            timestamp: Date.now()
          },
          {
            id: aiMsgId,
            role: 'assistant',
            content: [],
            isStreaming: true,
            timestamp: Date.now()
          }
        ]);
        break;
      }

      case 'models': {
        const modelsData = msg.data as { models: ModelInfo[]; current?: ModelInfo };
        setModels(modelsData.models);
        if (modelsData.current) {
          setCurrentModel(modelsData.current);
        }
        break;
      }

      case 'model_switched': {
        const switchData = msg.data as { success: boolean; model?: ModelInfo; error?: string };
        if (switchData.success && switchData.model) {
          setCurrentModel(switchData.model);
        }
        break;
      }
    }
  }, []);

  const { isConnected, latency, send } = useWebSocket({
    url: WS_URL,
    onMessage: handleMessage,
    onConnect: () => {
      // Request session history and models on connection
      send({ type: 'get_history', limit: 100 });
      send({ type: 'get_models' });
    },
    onDisconnect: () => {
      setIsProcessing(false);
      streamingIdRef.current = null;
    },
  });




  const handleSend = useCallback((text: string, images?: UploadImage[]) => {
    if (!isConnected || (!text.trim() && (!images || images.length === 0))) return;

    if (text === '/clear') {
      setMessages([]);
      hasHydratedHistoryRef.current = false;
      return;
    }

    if (text === '/new') {
      send({ type: 'command', command: 'new', args: [] });
      setMessages([]);
      streamingIdRef.current = null;
      skippedHeartbeatRef.current = false;
      hasHydratedHistoryRef.current = false;
      setIsProcessing(false);
      return;
    }

    const userMsgId = `usr-${Date.now()}`;
    const aiMsgId = `ai-${Date.now()}-stream`;

    streamingIdRef.current = aiMsgId;
    setIsProcessing(true);

    // Atomic insert avoids race windows where deltas can arrive between separate updates.
    setMessages(prev => [...prev,
      {
        id: userMsgId,
        role: 'user',
        content: text,
        images: images?.map((img) => img.dataUrl),
        timestamp: Date.now()
      },
      {
        id: aiMsgId,
        role: 'assistant',
        content: [],
        isStreaming: true,
        timestamp: Date.now()
      }
    ]);

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(' ');
      send({
        type: 'command',
        command: parts[0],
        args: parts.slice(1).filter(Boolean),
      });
    } else {
      const attachments = (images ?? [])
        .map((img) => dataUrlToAttachment(img.dataUrl))
        .filter((img): img is { mimeType: string; data: string } => img !== null);

      if (attachments.length > 0) {
        send({
          type: 'prompt_with_images',
          message: text,
          images: attachments,
        });
      } else {
        send({
          type: 'prompt',
          message: text,
        });
      }
    }
  }, [isConnected, send]);

  const handleAbort = useCallback(() => {
    send({ type: 'abort' });
  }, [send]);

  const handleSwitchModel = useCallback((provider: string, modelId: string) => {
    send({ type: 'switch_model', provider, modelId });
  }, [send]);

  // Keyboard shortcut: ESC to abort
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isProcessing) {
        handleAbort();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isProcessing, handleAbort]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const latestUsage = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.tokenUsage)
    ?.tokenUsage;

  // Status bar stats are based on the latest assistant turn, not cumulative sums.
  const sessionStats: SessionStats = {
    currentContextTokens: (latestUsage?.cacheRead ?? 0) + (latestUsage?.input ?? 0),
    lastTurnTokens: latestUsage?.total ?? 0,
    lastInput: latestUsage?.input ?? 0,
    lastOutput: latestUsage?.output ?? 0,
    lastCacheRead: latestUsage?.cacheRead ?? 0,
    lastCost: latestUsage?.cost ?? 0,
    messageCount: messages.length,
  };

  // Calculate context usage for compaction warning
  // Estimate compactThreshold as contextWindow - 16k reserve (typical Claude setup)
  // Default to 200k context window if unknown
  const estimatedContextWindow = 200000;
  const reserveTokens = 16384;
  const compactThreshold = estimatedContextWindow - reserveTokens;
  const currentContextTokens = sessionStats.currentContextTokens;
  const contextPercentage = Math.min(100, Math.round((currentContextTokens / compactThreshold) * 100));

  return (
    <div className="relative flex h-full flex-col">
      <StatusBar 
        sessionId={sessionId} 
        messageCount={messages.length} 
        isConnected={isConnected}
        gatewayUrl={WS_URL}
        sessionStats={sessionStats}
        showDebug={showDebug}
        onToggleDebug={() => setShowDebug(!showDebug)}
        latency={latency}
        contextPercentage={contextPercentage}
      />
      
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          onNewChat={() => {
            // Send /new command to archive session and start fresh
            send({ type: 'command', command: 'new', args: [] });
            setMessages([]);
            streamingIdRef.current = null;
            hasHydratedHistoryRef.current = false;
          }}
          onSwitchModel={handleSwitchModel}
          models={models}
          currentModel={currentModel}
          disabled={isProcessing}
        />
        <div className="flex flex-1 flex-col min-w-0">
          <MessageFeed messages={messages} />
          
          <InputArea 
            onSend={handleSend}
            onAbort={handleAbort}
            isProcessing={isProcessing}
            disabled={!isConnected}
            textareaRef={textareaRef}
          />
        </div>
        
        {showDebug && <DebugPanel messages={debugMessages} />}
      </div>
    </div>
  );
}
