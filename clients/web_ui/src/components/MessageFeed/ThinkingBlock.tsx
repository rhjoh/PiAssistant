export function ThinkingBlock({ content, isExpanded, onToggle, isStreaming }: { content: string; isExpanded: boolean; onToggle: () => void; isStreaming?: boolean }) {
  return (
    <div style={{ margin: '6px 0' }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-color)',
          borderBottom: isExpanded ? 'none' : '1px solid var(--border-color)',
          padding: '3px 8px',
          cursor: 'pointer',
          fontFamily: 'var(--font-primary)',
          fontSize: '10px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 400,
          color: 'var(--text-muted)',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-color-strong)';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-color)';
          e.currentTarget.style.color = 'var(--text-muted)';
        }}
      >
        <span style={{
          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block',
          fontSize: '9px',
          color: 'var(--text-secondary)',
        }}>
          ▶
        </span>
        <span>REASONING</span>
        {isStreaming && (
          <span
            style={{
              width: '5px',
              height: '5px',
              background: 'var(--accent-primary)',
              marginLeft: '4px',
              animation: 'pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '9px' }}>
          {content.length > 0 ? `${content.length} chars` : ''}
        </span>
      </button>
      {isExpanded && (
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-color)',
            borderTop: 'none',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-primary)',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.5',
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
