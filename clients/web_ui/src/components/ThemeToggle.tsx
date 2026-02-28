import { useTheme } from '@/hooks/useTheme';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isOps = theme === 'ops';

  return (
    <button
      onClick={toggleTheme}
      title={isOps ? 'Switch to Light theme' : 'Switch to Ops theme'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: isOps ? 'auto' : '32px',
        height: isOps ? '28px' : '32px',
        padding: isOps ? '4px 10px' : '0',
        background: isOps ? 'transparent' : 'transparent',
        border: isOps ? '1px solid var(--border-color-strong)' : '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-primary)',
        fontSize: isOps ? '10px' : '12px',
        fontWeight: isOps ? 400 : 500,
        letterSpacing: isOps ? '0.1em' : '0',
        textTransform: isOps ? 'uppercase' : 'none',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-primary)';
        e.currentTarget.style.color = 'var(--accent-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = isOps ? 'var(--border-color-strong)' : 'var(--border-color)';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      {isOps ? (
        <>
          <span style={{ fontSize: '11px' }}>◈</span>
          <span style={{ marginLeft: '4px' }}>OPS</span>
        </>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
      )}
    </button>
  );
}
