import { useRef, useEffect } from 'react';

interface DebugMessage {
  type: string;
  timestamp: number;
  data?: unknown;
}

interface DebugPanelProps {
  messages: DebugMessage[];
}

export function DebugPanel({ messages }: DebugPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'text_delta':
      case 'thinking_delta':
      case 'thinking_done':
        return '#4ade80';
      case 'tool_start':
      case 'tool_output':
      case 'tool_end':
        return '#f59e0b';
      case 'done':
        return '#4ade80';
      case 'error':
        return '#ef4444';
      case 'connection':
      case 'state':
        return '#4a5568';
      default:
        return '#94a3b8';
    }
  };

  return (
    <div
      style={{
        width: '420px',
        borderLeft: '1px solid #141c24',
        background: '#070809',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid #141c24',
          fontSize: '12px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: '#4a5568',
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        WS DEBUG // {messages.length} MSGS
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              padding: '16px',
              fontSize: '13px',
              color: '#2d3748',
              fontFamily: "'IBM Plex Mono', monospace",
              textAlign: 'center',
            }}
          >
            No messages...
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              padding: '6px 14px',
              borderBottom: '1px solid #0d0f12',
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                marginBottom: '3px',
              }}
            >
              <span style={{ fontSize: '11px', color: '#2d3748' }}>
                {formatTime(msg.timestamp)}
              </span>
              <span
                style={{
                  fontSize: '11px',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: getTypeColor(msg.type),
                  fontWeight: 500,
                }}
              >
                {msg.type}
              </span>
            </div>

            {msg.data !== undefined && msg.data !== null && (
              <div
                style={{
                  fontSize: '11px',
                  color: '#4a5568',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={String(msg.data)}
              >
                {truncateData(msg.data)}
              </div>
            )}
          </div>
        ))}

        <div ref={scrollRef} />
      </div>
    </div>
  );
}

function truncateData(data: unknown): string {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length <= 90) return str;
    return str.slice(0, 90) + '...';
  } catch {
    return '[object]';
  }
}
