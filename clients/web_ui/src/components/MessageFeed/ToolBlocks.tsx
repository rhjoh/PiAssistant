import { useState } from 'react';
import { extractImagePath, openImageInNewTab } from './utils';

export function ToolCallBlock({
  name,
  args,
  result,
  defaultExpanded = false,
}: {
  name: string;
  args?: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const commandPreview = args && typeof args.command === 'string' ? args.command : null;
  const pathPreview = args && typeof args.path === 'string' ? args.path : null;
  const upperName = name.toUpperCase();

  let displayName: string;
  if (upperName === 'BASH' && commandPreview) {
    displayName = commandPreview;
  } else if ((upperName === 'EDIT' || upperName === 'WRITE' || upperName === 'READ') && pathPreview) {
    displayName = pathPreview;
  } else {
    displayName = upperName;
  }

  const hasResult = result !== undefined;

  const extraArgs = (() => {
    if (!args) return null;
    const skip = upperName === 'BASH' ? 'command' : 'path';
    const filtered = Object.entries(args).filter(([k]) => k !== skip);
    if (filtered.length === 0) return null;
    return filtered.map(([k, v]) => (
      <span key={k} style={{ color: 'var(--text-muted)' }}>
        {k}: <span style={{ color: 'var(--text-secondary)' }}>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
      </span>
    ));
  })();

  return (
    <div style={{ margin: '10px 0' }}>
      {/* Collapsible header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          width: '100%',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderBottom: isExpanded && (hasResult || extraArgs) ? 'none' : '1px solid var(--border-color)',
          padding: '6px 10px',
          cursor: 'pointer',
          fontFamily: 'var(--font-primary)',
          fontSize: '12px',
          fontWeight: 400,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          textAlign: 'left',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--border-color-strong)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
      >
        <span style={{
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block',
          fontSize: '10px',
          color: 'var(--text-secondary)',
        }}>
          ▶
        </span>
        <span style={{ color: 'var(--accent-primary)' }}>TOOL.{upperName}</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{displayName}</span>
        {hasResult && (
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-muted)' }}>
            {result.isError ? 'ERR' : 'OK'}
          </span>
        )}
      </button>

      {isExpanded && (
        <>
          {/* Extra args row */}
          {extraArgs && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '12px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderTop: '1px dashed var(--border-color)',
                borderBottom: hasResult ? 'none' : '1px solid var(--border-color)',
                padding: '4px 10px',
                fontFamily: 'var(--font-primary)',
                fontSize: '10px',
                letterSpacing: '0.04em',
              }}
            >
              {extraArgs}
            </div>
          )}
          {/* Result body */}
          {hasResult && (
            <div
              style={{
                padding: '12px 14px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderTop: extraArgs ? 'none' : '1px dashed var(--border-color)',
                fontSize: '12px',
                color: 'var(--ai-text)',
                fontFamily: 'var(--font-primary)',
                whiteSpace: 'pre-wrap',
                lineHeight: '1.55',
              }}
            >
              {result.content}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ToolResultBlock({
  content,
  isError,
  defaultExpanded = false,
}: {
  content: string;
  isError?: boolean;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const imagePath = extractImagePath(content);

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

  return (
    <div style={{ margin: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            fontSize: '10px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 400,
            color: isError ? 'var(--accent-danger)' : 'var(--accent-primary)',
          }}
        >
          <span>RESULT</span>
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
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: copied ? 'var(--accent-primary)' : 'var(--text-secondary)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 6px',
            transition: 'color 0.15s'
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      {isExpanded && (
        <div
          style={{
            marginTop: '0',
            padding: '12px 14px',
            borderTop: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            fontSize: '13px',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-primary)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            borderRadius: '0'
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
                  borderRadius: '0',
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
