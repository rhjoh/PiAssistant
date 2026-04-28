import { useRef, useEffect, useState, useCallback } from 'react';
import { ChatMessage } from '@/types';
import { MessageRow } from './MessageRow';

interface MessageFeedProps {
  messages: ChatMessage[];
}

const STICKY_THRESHOLD_PX = 50;

export function MessageFeed({ messages }: MessageFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSticky, setIsSticky] = useState(true);

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
      className="flex-1 relative scrollbar-hide"
      style={{ padding: '0 56px 0 40px' }}
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
            borderRadius: '0',
            color: 'var(--accent-primary)',
            fontSize: '11px',
            fontFamily: 'var(--font-primary)',
            fontWeight: 400,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: 'none',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          <span style={{ width: '6px', height: '6px', background: 'var(--accent-primary)', borderRadius: '50%' }} />
          RESUME
        </button>
      )}
      <div style={{ maxWidth: '100%', margin: '0 auto' }}>
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
