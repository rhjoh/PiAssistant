import { useState, memo } from 'react';
import { ChatMessage } from '@/types';
import { MetadataColumn } from './MetadataColumn';
import { UserContent } from './UserContent';
import { SystemContent } from './SystemContent';
import { AssistantContent } from './AssistantContent';

interface MessageRowProps {
  msg: ChatMessage;
}

export const MessageRow = memo(function MessageRow({ msg }: MessageRowProps) {
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());

  const toggleThinking = (idx: number) => {
    setExpandedThinking(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div
      className="palantir-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: '0',
        padding: '0',
        borderBottom: '1px solid var(--border-color)',
        margin: '0',
        background: 'var(--bg-panel)',
        borderRadius: '0',
        boxShadow: 'none',
      }}
    >
      <MetadataColumn msg={msg} />
      <div>
        {msg.role === 'user' ? (
          <UserContent content={String(msg.content)} images={msg.images} />
        ) : msg.role === 'system' ? (
          <SystemContent content={String(msg.content)} />
        ) : (
          <AssistantContent
            content={msg.content}
            isStreaming={Boolean(msg.isStreaming)}
            expandedThinking={expandedThinking}
            onToggleThinking={toggleThinking}
            tokenUsage={msg.tokenUsage}
          />
        )}
      </div>
    </div>
  );
}, (prev, next) =>
  prev.msg.id === next.msg.id &&
  prev.msg.isStreaming === next.msg.isStreaming &&
  JSON.stringify(prev.msg.content) === JSON.stringify(next.msg.content) &&
  JSON.stringify(prev.msg.tokenUsage) === JSON.stringify(next.msg.tokenUsage)
);
