import { useState, useEffect } from 'react';
import type { SessionStats, ModelInfo } from '@/types';

interface StatusBarProps {
  sessionId: string;
  isConnected: boolean;
  gatewayUrl?: string;
  sessionStats?: SessionStats;
  showDebug?: boolean;
  onToggleDebug?: () => void;
  latency?: number | null;
  contextPercentage?: number;
  contextWindow?: number;
  currentModel?: ModelInfo;
}

export function StatusBar({ sessionId, isConnected, gatewayUrl, sessionStats, showDebug, onToggleDebug, latency, contextPercentage, contextWindow, currentModel }: StatusBarProps) {
  const [time, setTime] = useState('');

  const getContextColor = () => {
    if (!contextPercentage) return 'var(--text-secondary)';
    if (contextPercentage >= 90) return 'var(--accent-danger)';
    if (contextPercentage >= 80) return 'var(--accent-secondary)';
    return 'var(--text-secondary)';
  };

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = now.getUTCHours().toString().padStart(2, '0');
      const minutes = now.getUTCMinutes().toString().padStart(2, '0');
      const seconds = now.getUTCSeconds().toString().padStart(2, '0');
      setTime(`${hours}:${minutes}:${seconds} Z`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const fmt = (n: number) => n < 1000 ? n.toString() : `${(n / 1000).toFixed(1)}k`;

  return (
    <div
      className="flex items-center justify-between px-4 select-none"
      style={{
        background: 'var(--statusbar-bg)',
        borderBottom: '1px solid var(--statusbar-border)',
        fontFamily: 'var(--font-primary)',
        fontSize: '11px',
        fontWeight: 400,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        height: '36px',
      }}
    >
      <div className="flex items-center" style={{ gap: '0' }}>
        <span
          style={{
            color: isConnected ? 'var(--accent-success)' : 'var(--accent-danger)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0 12px',
            borderRight: '1px solid var(--border-color)',
            height: '100%',
          }}
        >
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '0',
            background: isConnected ? 'var(--accent-success)' : 'var(--accent-danger)',
          }} />
          {isConnected ? 'ONLINE' : 'OFFLINE'}
        </span>

        {isConnected && latency !== null && latency !== undefined && (
          <span style={{
            color: 'var(--text-secondary)',
            padding: '0 12px',
            borderRight: '1px solid var(--border-color)',
            height: '100%',
          }}>
            {latency}MS
          </span>
        )}

        {isConnected && currentModel && (
          <span style={{
            color: 'var(--text-secondary)',
            fontWeight: 400,
            padding: '0 12px',
            borderRight: '1px solid var(--border-color)',
            height: '100%',
          }}>
            {currentModel.name}
          </span>
        )}

        {isConnected && gatewayUrl && (
          <span style={{ color: 'var(--text-secondary)' }}>
            // {gatewayUrl.replace('ws://', '').replace('wss://', '')}
          </span>
        )}

        {sessionStats && (
          <>
            <span style={{
              color: 'var(--text-secondary)',
              padding: '0 12px',
              borderRight: '1px solid var(--border-color)',
              height: '100%',
            }}>
              {fmt(sessionStats.currentContextTokens)}{contextWindow ? `/${fmt(contextWindow)}` : ''} CTX
            </span>
            {sessionStats.lastCost > 0 && (
              <span style={{
                color: 'var(--text-secondary)',
                padding: '0 12px',
                borderRight: '1px solid var(--border-color)',
                height: '100%',
              }}>
                ${sessionStats.lastCost.toFixed(3)}
              </span>
            )}
            {contextPercentage !== undefined && contextPercentage >= 80 && (
              <span
                style={{
                  color: getContextColor(),
                  fontWeight: 600,
                  padding: '0 12px',
                  borderRight: '1px solid var(--border-color)',
                  height: '100%',
                }}
                title="Context approaching compaction threshold"
              >
                WARN {contextPercentage}%
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex items-center" style={{ gap: '0' }}>
        <button
          onClick={onToggleDebug}
          title={showDebug ? 'Hide debug panel' : 'Show debug panel'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '24px',
            padding: '0',
            background: showDebug ? 'var(--accent-primary-dim)' : 'transparent',
            border: `1px solid ${showDebug ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderRadius: '0',
            color: showDebug ? 'var(--accent-primary)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-primary)',
            fontSize: '11px',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!showDebug) {
              e.currentTarget.style.borderColor = 'var(--accent-primary)';
              e.currentTarget.style.color = 'var(--accent-primary)';
            }
          }}
          onMouseLeave={(e) => {
            if (!showDebug) {
              e.currentTarget.style.borderColor = 'var(--border-color)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
        </button>

        <div style={{
          color: 'var(--text-secondary)',
          padding: '0 12px',
          borderRight: '1px solid var(--border-color)',
          height: '100%',
        }}>
          <span style={{ color: 'var(--text-primary)' }}>{sessionId}</span>
        </div>

        <div className="flex items-center" style={{
          color: 'var(--text-secondary)',
          gap: '0',
          padding: '0 0 0 12px',
          height: '100%',
        }}>
          <span style={{ color: 'var(--text-primary)' }}>{time}</span>
        </div>
      </div>
    </div>
  );
}
