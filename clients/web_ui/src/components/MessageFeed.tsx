import { useRef, useEffect, useState, memo, useCallback } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { ChatMessage, MessageContent } from '@/types';

interface MessageFeedProps {
  messages: ChatMessage[];
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

const STICKY_THRESHOLD_PX = 50;

function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 128 || trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

function base64ToBlobUrl(base64: string, mimeType: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    return null;
  }
}

function toOpenableImageUrl(source: string): string {
  if (source.startsWith('data:')) {
    const match = source.match(/^data:(.+?);base64,(.+)$/);
    if (!match) return source;
    const [, mimeType, data] = match;
    return base64ToBlobUrl(data, mimeType) ?? source;
  }

  if (isLikelyBase64(source)) {
    return base64ToBlobUrl(source, 'image/png') ?? `data:image/png;base64,${source}`;
  }

  return source;
}

function openImageInNewTab(source: string): void {
  const openUrl = toOpenableImageUrl(source);
  window.open(openUrl, '_blank', 'noopener,noreferrer');
  if (openUrl.startsWith('blob:')) {
    setTimeout(() => URL.revokeObjectURL(openUrl), 60_000);
  }
}

export function MessageFeed({ messages }: MessageFeedProps) {
  const { theme } = useTheme();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSticky, setIsSticky] = useState(true);

  const isOps = theme === 'ops';

  const getDistanceFromBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 0;
    return container.scrollHeight - container.scrollTop - container.clientHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const distanceFromBottom = getDistanceFromBottom();
    const shouldBeSticky = distanceFromBottom < STICKY_THRESHOLD_PX;
    setIsSticky(prev => prev !== shouldBeSticky ? shouldBeSticky : prev);
  }, [getDistanceFromBottom]);

  useEffect(() => {
    if (isSticky && bottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }, [messages, isSticky]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.deltaY < 0) {
      const distanceFromBottom = getDistanceFromBottom();
      if (distanceFromBottom > STICKY_THRESHOLD_PX) {
        setIsSticky(false);
      }
    }
  }, [getDistanceFromBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleScroll, handleWheel]);

  const handleStickyClick = useCallback(() => {
    setIsSticky(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto relative"
      style={{ padding: '0 40px' }}
    >
      {!isSticky && (
        <button
          onClick={handleStickyClick}
          style={{
            position: 'fixed',
            bottom: '100px',
            right: '24px',
            zIndex: 50,
            padding: '8px 12px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--accent-primary)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--accent-primary)',
            fontSize: '11px',
            fontFamily: 'var(--font-primary)',
            fontWeight: isOps ? 400 : 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: isOps ? '0 0 12px rgba(74, 222, 128, 0.2)' : 'var(--shadow-md)',
            textTransform: isOps ? 'uppercase' : 'none',
            letterSpacing: isOps ? '0.1em' : '0',
          }}
        >
          <span style={{ 
            width: '6px', 
            height: '6px', 
            background: 'var(--accent-primary)',
            borderRadius: '50%'
          }} />
          {isOps ? 'RESUME AUTO-SCROLL' : 'Resume'}
        </button>
      )}
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {messages.map((msg) => (
          <MemoMessageRow key={msg.id} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

interface MessageRowProps {
  msg: ChatMessage;
}

function MessageRow({ msg }: MessageRowProps) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
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
      style={{
        display: 'grid',
        gridTemplateColumns: '90px 1fr',
        gap: '20px',
        padding: isOps ? '20px 0' : '14px 16px',
        borderBottom: isOps ? '1px solid var(--border-color)' : 'none',
        margin: isOps ? '0' : '8px 0',
        background: isOps ? 'transparent' : 'var(--bg-secondary)',
        border: isOps ? 'none' : '1px solid var(--border-color)',
        borderRadius: isOps ? '0' : 'var(--radius-lg)',
        boxShadow: isOps ? 'none' : 'var(--shadow-sm)',
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
}

const MemoMessageRow = memo(MessageRow, (prev, next) => 
  prev.msg.id === next.msg.id && 
  prev.msg.isStreaming === next.msg.isStreaming &&
  JSON.stringify(prev.msg.content) === JSON.stringify(next.msg.content) &&
  JSON.stringify(prev.msg.tokenUsage) === JSON.stringify(next.msg.tokenUsage)
);

function MetadataColumn({ msg }: { msg: ChatMessage }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';

  const getRoleLabel = () => {
    if (msg.role === 'user') return { text: isOps ? 'OPERATOR' : 'You', color: 'var(--accent-secondary)' };
    if (msg.role === 'system') return { text: isOps ? 'SYSTEM' : 'System', color: 'var(--accent-danger)' };
    return { text: isOps ? 'ASSISTANT' : 'Pi', color: 'var(--accent-primary)' };
  };

  const role = getRoleLabel();

  return (
    <div style={{ textAlign: 'right' }}>
      <div
        style={{
          fontSize: isOps ? '11px' : '12px',
          letterSpacing: isOps ? '0.12em' : '0.02em',
          textTransform: isOps ? 'uppercase' : 'none',
          fontWeight: isOps ? 400 : 600,
          color: role.color,
          marginBottom: '4px',
          fontFamily: 'var(--font-primary)',
          textShadow: msg.role === 'assistant' && isOps ? '0 0 8px rgba(74, 222, 128, 0.4)' : 'none'
        }}
      >
        {role.text}
      </div>
      <div style={{ 
        fontSize: '11px', 
        color: 'var(--text-secondary)', 
        fontFamily: 'var(--font-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '4px'
      }}>
        {msg.isStreaming && (
          <span
            style={{
              width: '4px',
              height: '4px',
              background: 'var(--accent-primary)',
              borderRadius: '50%',
              boxShadow: isOps ? '0 0 6px var(--accent-primary)' : 'none'
            }}
          />
        )}
        {formatTime(msg.timestamp || Date.now())}
      </div>
    </div>
  );
}

function UserContent({ content, images }: { content: string; images?: string[] }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';

  return (
    <div
      style={{
        borderLeft: isOps ? '2px solid var(--accent-secondary)' : 'none',
        background: isOps ? 'var(--user-bg)' : 'transparent',
        padding: isOps ? '10px 16px' : '4px 0',
        fontSize: isOps ? '14px' : '15px',
        color: 'var(--user-text)',
        lineHeight: '1.6',
        fontFamily: 'var(--font-primary)',
        borderRadius: isOps ? '0 var(--radius-md) var(--radius-md) 0' : '0',
        fontWeight: 400,
      }}
    >
      {content}
      {images && images.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          {images.map((img, idx) => (
            <img
              key={idx}
              src={img}
              alt={`Uploaded ${idx + 1}`}
              style={{
                maxWidth: '200px',
                maxHeight: '200px',
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-color)',
                cursor: 'pointer'
              }}
              onClick={() => openImageInNewTab(img)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SystemContent({ content }: { content: string }) {
  return (
    <div style={{ 
      fontSize: '13px', 
      color: 'var(--accent-danger)',
      fontFamily: 'var(--font-primary)'
    }}>
      {content}
    </div>
  );
}

interface AssistantContentProps {
  content: string | MessageContent[];
  isStreaming: boolean;
  expandedThinking: Set<number>;
  onToggleThinking: (idx: number) => void;
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number };
}

function AssistantContent({ content, isStreaming, expandedThinking, onToggleThinking, tokenUsage }: AssistantContentProps) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';

  const contents = typeof content === 'string'
    ? [{ type: 'text' as const, content }]
    : (Array.isArray(content) ? content : []);
  const showWaitingIndicator = isStreaming && contents.length === 0;

  return (
    <div style={{ 
      fontSize: isOps ? '15px' : '15px', 
      lineHeight: '1.7', 
      color: isOps ? 'var(--ai-text)' : 'var(--text-primary)',
      fontFamily: 'var(--font-secondary)'
    }}>
      {showWaitingIndicator && <ThinkingIndicator />}
      {contents.map((part, idx) => {
        switch (part.type) {
          case 'text':
            return <MarkdownContent key={idx} content={part.content} />;
          case 'thinking':
            return (
              <ThinkingBlock
                key={idx}
                content={part.content}
                isExpanded={expandedThinking.has(idx)}
                onToggle={() => onToggleThinking(idx)}
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
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)',
                  marginTop: '12px',
                  cursor: 'pointer'
                }}
                onClick={() => openImageInNewTab(part.url)}
              />
            );
          default:
            return null;
        }
      })}
      {tokenUsage && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginTop: '12px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-primary)',
          gap: '12px',
          letterSpacing: '0.02em'
        }}>
          <span>{tokenUsage.total.toLocaleString()} tokens</span>
          <span style={{ color: 'var(--accent-primary)' }}>
            ↓{tokenUsage.input.toLocaleString()} ↑{tokenUsage.output.toLocaleString()}
          </span>
          {tokenUsage.cacheRead > 0 && (
            <span style={{ color: 'var(--text-muted)' }}>cache {tokenUsage.cacheRead.toLocaleString()}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator() {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDotCount((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 320);

    return () => window.clearInterval(timer);
  }, []);

  const dots = '.'.repeat(dotCount);

  return (
    <div
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '0',
        margin: '6px 0 10px',
        padding: isOps ? '8px 12px' : '6px 0',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-primary)',
        fontSize: isOps ? '12px' : '14px',
        letterSpacing: isOps ? '0.1em' : '0.01em',
        textTransform: isOps ? 'uppercase' : 'none',
      }}
    >
      <span>Thinking</span>
      <span
        style={{
          display: 'inline-block',
          width: '1.6em',
          textAlign: 'left',
          color: 'var(--accent-primary)',
        }}
      >
        {dots}
      </span>
    </div>
  );
}

type MarkdownBlock = 
  | { type: 'paragraph'; content: InlineSegment[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'heading'; level: number; content: InlineSegment[] }
  | { type: 'list'; items: InlineSegment[][] };

interface InlineSegment {
  type: 'text' | 'bold' | 'code' | 'link';
  content: string;
  url?: string;
}

function MarkdownContent({ content }: { content: string }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
  const blocks = parseMarkdown(content);

  return (
    <div style={{ fontFamily: isOps ? 'var(--font-secondary)' : 'var(--font-secondary)' }}>
      {blocks.map((block, i) => renderBlock(block, i, isOps))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, key: number, _isOps: boolean): React.ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre
          key={key}
          style={{
            margin: '12px 0',
            padding: '12px 16px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color-strong)',
            borderRadius: 'var(--radius-md)',
            overflow: 'auto',
            maxWidth: '100%'
          }}
        >
          {block.language && (
            <div
              style={{
                fontSize: '10px',
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                marginBottom: '8px',
                fontFamily: 'var(--font-primary)',
                fontWeight: 500
              }}
            >
              {block.language}
            </div>
          )}
          <code
            style={{
              fontSize: '13px',
              lineHeight: '1.6',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-primary)',
              whiteSpace: 'pre'
            }}
          >
            {block.code}
          </code>
        </pre>
      );

    case 'heading':
      const headingSize = block.level === 1 ? '24px' : block.level === 2 ? '20px' : '17px';
      return (
        <h3
          key={key}
          style={{
            fontSize: headingSize,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '16px 0 12px 0',
            fontFamily: 'var(--font-secondary)'
          }}
        >
          {renderInline(block.content)}
        </h3>
      );

    case 'list':
      return (
        <ul key={key} style={{ margin: '12px 0', paddingLeft: '20px' }}>
          {block.items.map((item, idx) => (
            <li key={idx} style={{ margin: '4px 0', color: 'var(--ai-text)' }}>
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );

    case 'paragraph':
    default:
      return (
        <p key={key} style={{ margin: '12px 0', whiteSpace: 'pre-wrap' }}>
          {renderInline(block.content)}
        </p>
      );
  }
}

function renderInline(segments: InlineSegment[]): React.ReactNode[] {
  return segments.map((seg, i) => {
    if (seg.type === 'bold') {
      return <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{seg.content}</strong>;
    }
    if (seg.type === 'code') {
      return (
        <code
          key={i}
          style={{
            padding: '2px 6px',
            background: 'var(--bg-input)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '13px',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-primary)'
          }}
        >
          {seg.content}
        </code>
      );
    }
    if (seg.type === 'link') {
      return (
        <a
          key={i}
          href={seg.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'var(--accent-info)',
            textDecoration: 'underline',
            cursor: 'pointer'
          }}
        >
          {seg.content}
        </a>
      );
    }
    return <span key={i}>{seg.content}</span>;
  });
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const fence = line.match(/^```(\w*)/);
      const language = fence ? fence[1] : '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: parseInline(headingMatch[2])
      });
      i++;
      continue;
    }

    if (line.match(/^[-*]\s/)) {
      const items: InlineSegment[][] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        items.push(parseInline(lines[i].replace(/^[-*]\s+/, '')));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') && !lines[i].match(/^(#{1,6})\s/) && !lines[i].match(/^[-*]\s/)) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', content: parseInline(paraLines.join('\n')) });
  }

  return blocks;
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const urlMatch = remaining.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);

    type MatchType = { type: 'bold' | 'code' | 'link' | 'url'; index: number; end: number; content: string; url?: string };
    let earliestMatch: MatchType | null = null;

    if (codeMatch) {
      earliestMatch = { type: 'code', index: codeMatch.index!, end: codeMatch.index! + codeMatch[0].length, content: codeMatch[1] };
    }
    if (boldMatch) {
      if (!earliestMatch || boldMatch.index! < earliestMatch.index) {
        earliestMatch = { type: 'bold', index: boldMatch.index!, end: boldMatch.index! + boldMatch[0].length, content: boldMatch[1] };
      }
    }
    if (linkMatch) {
      if (!earliestMatch || linkMatch.index! < earliestMatch.index) {
        earliestMatch = { type: 'link', index: linkMatch.index!, end: linkMatch.index! + linkMatch[0].length, content: linkMatch[1], url: linkMatch[2] };
      }
    }
    if (urlMatch) {
      if (!earliestMatch || urlMatch.index! < earliestMatch.index) {
        earliestMatch = { type: 'url', index: urlMatch.index!, end: urlMatch.index! + urlMatch[0].length, content: urlMatch[0], url: urlMatch[0] };
      }
    }

    if (earliestMatch && earliestMatch.index > 0) {
      segments.push({ type: 'text', content: remaining.slice(0, earliestMatch.index) });
    }

    if (earliestMatch) {
      if (earliestMatch.type === 'url') {
        segments.push({ type: 'link', content: earliestMatch.content, url: earliestMatch.url });
      } else {
        segments.push({ type: earliestMatch.type, content: earliestMatch.content, url: earliestMatch.url });
      }
      remaining = remaining.slice(earliestMatch.end);
    } else {
      segments.push({ type: 'text', content: remaining });
      break;
    }
  }

  return segments;
}

function ThinkingBlock({ content, isExpanded, onToggle }: { content: string; isExpanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';

  return (
    <div style={{ margin: '12px 0' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'transparent',
          border: 'none',
          padding: '4px 0',
          cursor: 'pointer',
          fontFamily: 'var(--font-primary)',
          fontSize: isOps ? '11px' : '12px',
          letterSpacing: isOps ? '0.08em' : '0',
          textTransform: isOps ? 'uppercase' : 'none',
          fontWeight: isOps ? 400 : 500,
          color: isExpanded ? 'var(--accent-primary)' : 'var(--text-secondary)',
        }}
      >
        <span>{isOps ? '[REASONING]' : 'Reasoning'}</span>
        <span style={{
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block'
        }}>
          ▶
        </span>
      </button>
      {isExpanded && (
        <div
          style={{
            marginTop: '8px',
            padding: '10px 12px',
            borderLeft: '2px solid var(--accent-primary)',
            background: 'var(--bg-input)',
            fontSize: '13px',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-secondary)',
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0'
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ name, args }: { name: string; args?: Record<string, unknown> }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
  const [isExpanded, setIsExpanded] = useState(false);

  const commandPreview = args && typeof args.command === 'string' ? args.command : null;
  const pathPreview = args && typeof args.path === 'string' ? args.path : null;

  const upperName = name.toUpperCase();
  let displayName: string;

  if (upperName === 'BASH' && commandPreview) {
    displayName = `BASH - ${commandPreview}`;
  } else if ((upperName === 'EDIT' || upperName === 'WRITE' || upperName === 'READ') && pathPreview) {
    displayName = `${upperName} - ${pathPreview}`;
  } else {
    displayName = upperName;
  }

  return (
    <div style={{ margin: '12px 0' }}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'transparent',
          border: 'none',
          padding: '4px 0',
          cursor: 'pointer',
          fontFamily: 'var(--font-primary)',
          fontSize: isOps ? '11px' : '12px',
          letterSpacing: isOps ? '0.08em' : '0',
          textTransform: isOps ? 'uppercase' : 'none',
          fontWeight: isOps ? 400 : 500,
          color: 'var(--accent-secondary)',
        }}
      >
        <span>{isOps ? '[TOOL]' : 'Tool'}</span>
        <span>{displayName}</span>
        <span style={{
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block'
        }}>
          ▶
        </span>
      </button>
      {isExpanded && args && (
        <div
          style={{
            marginTop: '8px',
            padding: '10px 12px',
            borderLeft: '2px solid var(--accent-secondary)',
            background: 'var(--bg-input)',
            fontSize: '12px',
            color: 'var(--ai-text)',
            fontFamily: 'var(--font-primary)',
            whiteSpace: 'pre-wrap',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0'
          }}
        >
          {JSON.stringify(args, null, 2)}
        </div>
      )}
    </div>
  );
}

// Helper to detect if content contains an image path
function extractImagePath(content: string): string | null {
  // Match common image extensions in paths
  const imagePathRegex = /["']?(\/~\/[^"'\s]+\.(?:png|jpg|jpeg|gif|webp|bmp))["']?/i;
  const match = content.match(imagePathRegex);
  return match ? match[1] : null;
}

function ToolResultBlock({ content, isError }: { content: string; isError?: boolean }) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  // Check if this is an image result
  const imagePath = extractImagePath(content);

  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'transparent',
            border: 'none',
            padding: '4px 0',
            cursor: 'pointer',
            fontFamily: 'var(--font-primary)',
            fontSize: isOps ? '11px' : '12px',
            letterSpacing: isOps ? '0.08em' : '0',
            textTransform: isOps ? 'uppercase' : 'none',
            fontWeight: isOps ? 400 : 500,
            color: isError ? 'var(--accent-danger)' : 'var(--text-secondary)',
          }}
        >
          <span>{isOps ? '[RESULT]' : 'Result'}</span>
          <span style={{
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            display: 'inline-block'
          }}>
            ▶
          </span>
        </button>
        <button
          onClick={handleCopy}
          style={{
            fontFamily: 'var(--font-primary)',
            fontSize: '10px',
            letterSpacing: isOps ? '0.08em' : '0',
            textTransform: isOps ? 'uppercase' : 'none',
            color: copied ? 'var(--accent-primary)' : 'var(--text-secondary)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 6px',
            transition: 'color 0.15s'
          }}
        >
          {copied ? (isOps ? '[COPIED]' : 'Copied!') : (isOps ? '[COPY]' : 'Copy')}
        </button>
      </div>
      {isExpanded && (
        <div
          style={{
            marginTop: '8px',
            padding: '10px 12px',
            borderLeft: `2px solid ${isError ? 'var(--accent-danger)' : 'var(--text-secondary)'}`,
            background: 'var(--bg-input)',
            fontSize: '12px',
            color: 'var(--ai-text)',
            fontFamily: 'var(--font-primary)',
            whiteSpace: 'pre-wrap',
            maxHeight: '300px',
            overflow: 'auto',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0'
          }}
        >
          {content}
          {imagePath && (
            <div style={{ marginTop: '12px' }}>
              <img
                src={`http://localhost:3457/files/${encodeURIComponent(imagePath)}`}
                alt="Tool result"
                style={{
                  maxWidth: '100%',
                  maxHeight: '400px',
                  objectFit: 'contain',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer'
                }}
                onClick={() => openImageInNewTab(`http://localhost:3457/files/${encodeURIComponent(imagePath)}`)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
