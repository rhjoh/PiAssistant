import { useState, useEffect } from 'react';

const BOOT_LINES = [
  'INITIALIZING FOUNDRY CONSOLE...',
  'SYSTEMS CHECK: PASS',
  'GATEWAY LINK: ESTABLISHED',
  'MODEL REGISTRY: LOADED',
  'TELEMETRY: ONLINE',
  'READY.',
];

interface BootSequenceProps {
  onComplete: () => void;
}

export function BootSequence({ onComplete }: BootSequenceProps) {
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    let currentLine = 0;
    const interval = setInterval(() => {
      if (currentLine < BOOT_LINES.length) {
        setVisibleLines(prev => [...prev, BOOT_LINES[currentLine]]);
        setProgress(((currentLine + 1) / BOOT_LINES.length) * 100);
        currentLine++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          setFading(true);
          setTimeout(onComplete, 500);
        }, 400);
      }
    }, 240);

    return () => clearInterval(interval);
  }, [onComplete]);

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
        opacity: fading ? 0 : 1,
        transition: 'opacity 500ms ease'
      }}
    >
      <div style={{ width: '480px' }}>
        <div style={{
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-inverse)',
            fontSize: '16px',
            fontWeight: 600
          }}>
            π
          </div>
          <div style={{
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-secondary)'
          }}>
            Pi Assistant
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visibleLines.map((line, i) => (
            <div
              key={i}
              style={{
                fontFamily: 'var(--font-primary)',
                fontSize: '13px',
                color: 'var(--accent-primary)'
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>&gt;</span>{' '}{line}
            </div>
          ))}
        </div>

        <div style={{
          marginTop: '24px',
          height: '2px',
          width: '100%',
          background: 'var(--border-color)',
          borderRadius: '1px'
        }}>
          <div
            style={{
              height: '100%',
              background: 'var(--accent-primary)',
              borderRadius: '1px',
              width: `${progress}%`,
              transition: 'width 300ms ease'
            }}
          />
        </div>
      </div>
    </div>
  );
}
