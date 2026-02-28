import { useState, useEffect } from 'react';
import { useTheme } from '@/hooks/useTheme';

const OPS_BOOT_LINES = [
  'INITIALIZING SECURE CHANNEL...',
  'AUTHENTICATION LAYER: ACTIVE',
  'MEMORY PARTITION: ALLOCATED',
  'CONTEXT WINDOW: OPEN',
  'ENCRYPTION: AES-256',
  'ASSISTANT READY.',
];

const SAAS_BOOT_LINES = [
  'Loading Pi Assistant...',
  'Connecting to gateway...',
  'Initializing session...',
  'Ready.',
];

interface BootSequenceProps {
  onComplete: () => void;
}

export function BootSequence({ onComplete }: BootSequenceProps) {
  const { theme } = useTheme();
  const isOps = theme === 'ops';
  const [visibleLines, setVisibleLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);

  const bootLines = isOps ? OPS_BOOT_LINES : SAAS_BOOT_LINES;

  useEffect(() => {
    let currentLine = 0;
    const interval = setInterval(() => {
      if (currentLine < bootLines.length) {
        setVisibleLines(prev => [...prev, bootLines[currentLine]]);
        setProgress(((currentLine + 1) / bootLines.length) * 100);
        currentLine++;
      } else {
        clearInterval(interval);
        setTimeout(() => {
          setFading(true);
          setTimeout(onComplete, 500);
        }, 400);
      }
    }, isOps ? 280 : 200);

    return () => clearInterval(interval);
  }, [onComplete, bootLines, isOps]);

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
        {isOps ? (
          <div style={{ 
            marginBottom: '24px', 
            fontSize: '11px', 
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            color: 'var(--text-secondary)'
          }}>
            CLEARANCE: LEVEL 5 // EYES ONLY
          </div>
        ) : (
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
        )}
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {visibleLines.map((line, i) => (
            <div 
              key={i} 
              style={{ 
                fontFamily: 'var(--font-primary)',
                fontSize: isOps ? '13px' : '14px',
                color: isOps ? 'var(--accent-primary)' : 'var(--text-secondary)'
              }}
            >
              {isOps && (
                <span style={{ color: 'var(--text-muted)' }}>&gt;</span>
              )} {line}
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
