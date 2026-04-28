import { useTheme } from '@/hooks/useTheme';
import type { SessionStats, ModelInfo } from '@/types';

interface TelemetryPanelProps {
  isConnected: boolean;
  currentModel?: ModelInfo;
  sessionStats?: SessionStats;
  contextPercentage?: number;
  contextWindow?: number;
  latency?: number | null;
}

function Gauge({ value, max, label, unit }: { value: number; max: number; label: string; unit?: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const fillClass = pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : '';

  return (
    <div style={{ marginBottom: '14px' }}>
      <div className="foundry-label" style={{ marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{pct}{unit || '%'}</span>
      </div>
      <div className="foundry-gauge-track">
        <div className={`foundry-gauge-fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Readout({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      <div className="foundry-label" style={{ marginBottom: '4px' }}>{label}</div>
      <div className="foundry-readout" style={{ color: color || 'var(--accent-primary)' }}>
        {value}
      </div>
    </div>
  );
}

export function TelemetryPanel({
  isConnected,
  currentModel,
  sessionStats,
  contextPercentage,
  contextWindow,
  latency,
}: TelemetryPanelProps) {
  const { theme } = useTheme();
  const isFoundry = theme.startsWith('foundry');

  if (!isFoundry) return null;

  const fmt = (n: number) => n < 1000 ? n.toString() : `${(n / 1000).toFixed(1)}k`;

  return (
    <div
      style={{
        width: '200px',
        minWidth: '200px',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Panel header */}
      <div
        style={{
          height: '36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--statusbar-bg)',
        }}
      >
        <span className="foundry-label" style={{ color: 'var(--text-secondary)' }}>Telemetry</span>
        <div className={`foundry-lamp ${isConnected ? 'on' : 'critical'}`} />
      </div>

      <div className="scrollbar-hide" style={{ flex: 1, padding: '14px 12px' }}>
        {/* System status */}
        <div style={{ marginBottom: '18px' }}>
          <div className="foundry-label" style={{ marginBottom: '8px' }}>System Status</div>
          <div
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-primary)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: isConnected ? 'var(--accent-success)' : 'var(--accent-danger)',
              padding: '6px 8px',
              border: `1px solid ${isConnected ? 'var(--accent-success)' : 'var(--accent-danger)'}`,
              opacity: 0.8,
            }}
          >
            {isConnected ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>

        {/* Model designation */}
        {currentModel && (
          <div style={{ marginBottom: '18px' }}>
            <div className="foundry-label" style={{ marginBottom: '6px' }}>Model Designation</div>
            <div
              style={{
                fontSize: '11px',
                fontFamily: 'var(--font-primary)',
                color: 'var(--text-primary)',
                padding: '6px 8px',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-input)',
                wordBreak: 'break-word',
              }}
            >
              {currentModel.name}
            </div>
            <div
              style={{
                fontSize: '9px',
                fontFamily: 'var(--font-primary)',
                color: 'var(--text-muted)',
                marginTop: '4px',
                letterSpacing: '0.04em',
              }}
            >
              {currentModel.provider}/{currentModel.id}
            </div>
          </div>
        )}

        {/* Context gauge */}
        {contextPercentage !== undefined && contextWindow && (
          <Gauge
            value={contextPercentage}
            max={100}
            label="Context Load"
          />
        )}

        {/* Token readouts */}
        {sessionStats && (
          <>
            <Readout
              label="Last Turn Tokens"
              value={fmt(sessionStats.lastTurnTokens)}
            />
            <Readout
              label="Context Tokens"
              value={`${fmt(sessionStats.currentContextTokens)}${contextWindow ? ` / ${fmt(contextWindow)}` : ''}`}
              color={contextPercentage && contextPercentage >= 80 ? 'var(--accent-danger)' : undefined}
            />
            {sessionStats.lastCost > 0 && (
              <Readout
                label="Last Turn Cost"
                value={`$${sessionStats.lastCost.toFixed(4)}`}
              />
            )}
          </>
        )}

        {/* Latency */}
        {latency !== null && latency !== undefined && (
          <Readout
            label="Latency"
            value={`${latency}ms`}
            color={latency > 500 ? 'var(--accent-secondary)' : latency > 1000 ? 'var(--accent-danger)' : undefined}
          />
        )}

        {/* Message count */}
        {sessionStats && (
          <Readout
            label="Messages"
            value={sessionStats.messageCount.toString()}
          />
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border-color)',
          background: 'var(--statusbar-bg)',
        }}
      >
        <div className="foundry-label" style={{ fontSize: '8px', textAlign: 'center' }}>
          FOUNDRY v1.0 // INDUSTRIAL CONSOLE
        </div>
      </div>
    </div>
  );
}
