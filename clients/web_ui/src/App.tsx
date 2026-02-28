import { useState, useEffect, useRef, useCallback } from 'react';
import { BootSequence } from '@/components/BootSequence';
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
  const trimmed = text.trim();
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

export default function App() {
  const [bootComplete, setBootComplete] = useState(false);
  const [sessionId] = useState(() => generateSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [debugMessages, setDebugMessages] = useState<Array<{type: string; timestamp: number; data?: unknown}>>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | undefined>();
  const streamingIdRef = useRef<string | null>(null);
  const skippedHeartbeatRef = useRef<boolean>(false);
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
              tokenUsage: m.usage as TokenUsage | undefined,
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
        
        setMessages(loadedMessages);
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
          // Find target: use streamingIdRef if available, otherwise find most recent streaming assistant
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;

          if (!targetMsg) {
            targetMsg = [...prev].reverse().find(m => m.role === 'assistant' && m.isStreaming);
            if (targetMsg) {
              streamingIdRef.current = targetMsg.id;
              targetId = targetMsg.id;
            }
          }

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
          // Find target: use streamingIdRef if available, otherwise find most recent streaming assistant
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          if (!targetMsg) {
            targetMsg = [...prev].reverse().find(m => m.role === 'assistant' && m.isStreaming);
            if (targetMsg) {
              streamingIdRef.current = targetMsg.id;
              targetId = targetMsg.id;
            }
          }
          
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
          // Find target: use streamingIdRef if available, otherwise find most recent streaming assistant
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          if (!targetMsg) {
            targetMsg = [...prev].reverse().find(m => m.role === 'assistant' && m.isStreaming);
            if (targetMsg) {
              streamingIdRef.current = targetMsg.id;
              targetId = targetMsg.id;
            }
          }
          
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
          // Find target: use streamingIdRef if available, otherwise find most recent streaming assistant
          let targetId = streamingIdRef.current;
          let targetMsg = targetId ? prev.find(m => m.id === targetId) : null;
          
          if (!targetMsg) {
            targetMsg = [...prev].reverse().find(m => m.role === 'assistant' && m.isStreaming);
            if (targetMsg) {
              streamingIdRef.current = targetMsg.id;
              targetId = targetMsg.id;
            }
          }
          
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

          if (!targetMsg) {
            targetMsg = [...prev].reverse().find(m => m.role === 'assistant' && m.isStreaming);
            if (targetMsg) {
              targetId = targetMsg.id;
              streamingIdRef.current = targetId;
            }
          }

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
        const doneData = msg.data as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number } } | undefined;
        const currentId = streamingIdRef.current;
        if (currentId) {
          setMessages(prev => {
            const targetMsg = prev.find(m => m.id === currentId);
            // Filter out heartbeat responses
            if (targetMsg && isHeartbeatMessage(targetMsg.content)) {
              return prev.filter(m => m.id !== currentId);
            }
            return prev.map(m =>
              m.id === currentId
                ? { ...m, isStreaming: false, tokenUsage: doneData?.usage }
                : m
            );
          });
          streamingIdRef.current = null;
        }
        // Reset heartbeat skip flag after processing done
        skippedHeartbeatRef.current = false;
        break;
      }

      case 'error': {
        const errorMsg = (msg.data as { message: string }).message;
        setIsProcessing(false);
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
  });



  const handleSend = useCallback((text: string, images?: UploadImage[]) => {
    if (!isConnected || (!text.trim() && (!images || images.length === 0))) return;

    if (text === '/clear') {
      setMessages([]);
      return;
    }

    const userMsgId = `usr-${Date.now()}`;
    const aiMsgId = `ai-${Date.now()}-stream`;

    setMessages(prev => [...prev, {
      id: userMsgId,
      role: 'user',
      content: text,
      images: images?.map((img) => img.dataUrl),
      timestamp: Date.now()
    }]);

    setMessages(prev => [...prev, {
      id: aiMsgId,
      role: 'assistant',
      content: [],
      isStreaming: true,
      timestamp: Date.now()
    }]);

    streamingIdRef.current = aiMsgId;
    setIsProcessing(true);

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
    if (bootComplete && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [bootComplete]);

  // Calculate session stats from accumulated message token usage
  const sessionStats: SessionStats = {
    totalTokens: messages.reduce((sum, m) => sum + (m.tokenUsage?.total ?? 0), 0),
    totalInput: messages.reduce((sum, m) => sum + (m.tokenUsage?.input ?? 0), 0),
    totalOutput: messages.reduce((sum, m) => sum + (m.tokenUsage?.output ?? 0), 0),
    totalCacheRead: messages.reduce((sum, m) => sum + (m.tokenUsage?.cacheRead ?? 0), 0),
    totalCost: messages.reduce((sum, m) => sum + (m.tokenUsage?.cost ?? 0), 0),
    messageCount: messages.length,
  };

  // Calculate context usage for compaction warning
  // Estimate compactThreshold as contextWindow - 16k reserve (typical Claude setup)
  // Default to 200k context window if unknown
  const estimatedContextWindow = 200000;
  const reserveTokens = 16384;
  const compactThreshold = estimatedContextWindow - reserveTokens;
  const currentContextTokens = sessionStats.totalCacheRead + sessionStats.totalInput;
  const contextPercentage = Math.min(100, Math.round((currentContextTokens / compactThreshold) * 100));

  if (!bootComplete) {
    return <BootSequence onComplete={() => setBootComplete(true)} />;
  }

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
