import { useRef, useEffect, useState, useCallback } from 'react';
import { ChatMessage } from '@/types';
import { MessageRow } from './MessageRow';

interface MessageFeedProps {
  messages: ChatMessage[];
}

const STUCK_THRESHOLD_PX = 50;

export function MessageFeed({ messages }: MessageFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isStuckRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const [isStuck, setIsStuck] = useState(true);

  const setStuck = useCallback((stuck: boolean) => {
    isStuckRef.current = stuck;
    setIsStuck(stuck);
  }, []);

  const getDistanceFromBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return 0;
    return container.scrollHeight - container.scrollTop - container.clientHeight;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const updateStuckFromScroll = useCallback(() => {
    const distanceFromBottom = getDistanceFromBottom();
    setStuck(distanceFromBottom < STUCK_THRESHOLD_PX);
  }, [getDistanceFromBottom, setStuck]);

  const unstick = useCallback(() => {
    if (isStuckRef.current) {
      setStuck(false);
    }
  }, [setStuck]);

  const maybeScrollToBottom = useCallback(() => {
    if (!isStuckRef.current) return;

    const container = containerRef.current;
    if (!container) return;

    const scrollHeight = container.scrollHeight;
    if (scrollHeight <= lastScrollHeightRef.current) return;

    lastScrollHeightRef.current = scrollHeight;
    scrollToBottom('auto');
  }, [scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    lastScrollHeightRef.current = container.scrollHeight;
    if (isStuckRef.current) {
      scrollToBottom('auto');
    }

    const resizeObserver = new ResizeObserver(() => {
      maybeScrollToBottom();
    });
    resizeObserver.observe(content);

    const handleScroll = () => {
      updateStuckFromScroll();
    };

    const handleWheel = (e: WheelEvent) => {
      // Unstick immediately on upward intent, even when still at the bottom.
      if (e.deltaY < 0) {
        unstick();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [maybeScrollToBottom, scrollToBottom, unstick, updateStuckFromScroll]);

  const handleResume = useCallback(() => {
    setStuck(true);
    scrollToBottom('smooth');
    lastScrollHeightRef.current = containerRef.current?.scrollHeight ?? 0;
  }, [scrollToBottom, setStuck]);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative scrollbar-hide"
      style={{ padding: '0 56px 0 40px' }}
    >
      {!isStuck && (
        <button
          onClick={handleResume}
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
      <div ref={contentRef} style={{ maxWidth: '100%', margin: '0 auto' }}>
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        <div aria-hidden="true" />
      </div>
    </div>
  );
}