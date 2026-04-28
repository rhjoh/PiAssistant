export function ThinkingIndicator() {
  return (
    <div
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        margin: '8px 0',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-primary)',
        fontSize: '10px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span>Processing</span>
      <span className="thinking-bars">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
