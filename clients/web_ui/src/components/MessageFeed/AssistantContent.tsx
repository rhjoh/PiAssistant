import { MessageContent, TokenUsage } from '@/types';
import { MarkdownContent } from './MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks';

interface AssistantContentProps {
  content: string | MessageContent[];
  isStreaming: boolean;
  expandedThinking: Set<number>;
  onToggleThinking: (idx: number) => void;
  tokenUsage?: TokenUsage;
}

function groupToolContent(contents: MessageContent[]): Array<
  | MessageContent
  | { type: 'tool_group'; call: Extract<MessageContent, { type: 'tool_call' }>; result?: Extract<MessageContent, { type: 'tool_result' }> }
> {
  // Index all results by toolCallId — handles out-of-order or interleaved content
  const resultById = new Map<string, Extract<MessageContent, { type: 'tool_result' }>>();
  for (const part of contents) {
    if (part.type === 'tool_result') {
      resultById.set(part.toolCallId, part as Extract<MessageContent, { type: 'tool_result' }>);
    }
  }

  const grouped: Array<
    | MessageContent
    | { type: 'tool_group'; call: Extract<MessageContent, { type: 'tool_call' }>; result?: Extract<MessageContent, { type: 'tool_result' }> }
  > = [];
  const consumedResults = new Set<string>();

  for (const part of contents) {
    if (part.type === 'tool_call') {
      const result = resultById.get(part.id);
      if (result) consumedResults.add(part.id);
      grouped.push({ type: 'tool_group', call: part as Extract<MessageContent, { type: 'tool_call' }>, result });
    } else if (part.type === 'tool_result') {
      // Only show orphaned results (not matched to any call)
      if (!consumedResults.has(part.toolCallId)) {
        grouped.push(part);
      }
    } else {
      grouped.push(part);
    }
  }
  return grouped;
}

export function AssistantContent({ content, isStreaming, expandedThinking, onToggleThinking, tokenUsage }: AssistantContentProps) {
  const rawContents = typeof content === 'string'
    ? [{ type: 'text' as const, content }]
    : (Array.isArray(content) ? content : []);

  const contents = groupToolContent(rawContents);
  const showWaitingIndicator = isStreaming && contents.length === 0;

  return (
    <div style={{
      fontSize: '13px',
      lineHeight: '1.55',
      color: 'var(--ai-text)',
      fontFamily: 'var(--font-secondary)',
      overflowWrap: 'break-word',
      padding: '10px 16px',
    }}>
      {showWaitingIndicator && (
        <ThinkingBlock key="thinking-placeholder" content="" isExpanded={true} onToggle={() => {}} isStreaming={true} />
      )}
      {contents.map((part, idx) => {
        if (part.type === 'tool_group') {
          return <ToolCallBlock key={idx} name={part.call.name} args={part.call.args} result={part.result} />;
        }
        switch (part.type) {
          case 'text':
            return <MarkdownContent key={idx} content={part.content} />;
          case 'thinking':
            return (
              <ThinkingBlock
                key={part.thinkingId || idx}
                content={part.content}
                isExpanded={isStreaming || expandedThinking.has(idx)}
                onToggle={() => onToggleThinking(idx)}
                isStreaming={isStreaming}
              />
            );
          case 'tool_call':
            return <ToolCallBlock key={idx} name={part.name} args={part.args} />;
          case 'tool_result':
            return <ToolResultBlock key={idx} content={part.content} isError={part.isError} />;
          case 'image':
            return (
              <img
                key={idx}
                src={part.url}
                alt={part.alt || 'Generated image'}
                style={{
                  maxWidth: '100%',
                  maxHeight: '512px',
                  objectFit: 'contain',
                  borderRadius: '0',
                  border: '1px solid var(--border-color)',
                  marginTop: '12px',
                  cursor: 'pointer'
                }}
              />
            );
          default:
            return null;
        }
      })}
      {tokenUsage && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: '12px',
            fontSize: '10px',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-primary)',
            gap: '16px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          <span>{tokenUsage.total.toLocaleString()}TK</span>
          {tokenUsage.input > 0 && <span>IN {tokenUsage.input.toLocaleString()}</span>}
          {tokenUsage.output > 0 && <span>OUT {tokenUsage.output.toLocaleString()}</span>}
          {tokenUsage.cacheRead > 0 && <span style={{ color: 'var(--text-muted)' }}>CCH {tokenUsage.cacheRead.toLocaleString()}</span>}
          {tokenUsage.cost !== undefined && tokenUsage.cost > 0 && <span>${tokenUsage.cost.toFixed(4)}</span>}
        </div>
      )}
    </div>
  );
}
