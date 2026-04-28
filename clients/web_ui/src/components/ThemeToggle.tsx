import { useTheme } from '@/hooks/useTheme';

const THEME_LABELS: Record<string, string> = {
  foundry: 'Foundry',
  'foundry-light': 'Foundry Day',
};

export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();

  return (
    <button
      onClick={cycleTheme}
      title={`Switch theme (current: ${THEME_LABELS[theme]})`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '28px',
        padding: '4px 10px',
        background: 'transparent',
        border: '1px solid var(--border-color-strong)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-primary)',
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.05em',
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent-primary)';
        e.currentTarget.style.color = 'var(--accent-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-color-strong)';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      {theme === 'foundry' && (
        <span style={{ fontSize: '11px', marginRight: '4px' }}>▣</span>
      )}
      {theme === 'foundry-light' && (
        <span style={{ fontSize: '11px', marginRight: '4px' }}>◫</span>
      )}
      <span>{THEME_LABELS[theme]}</span>
    </button>
  );
}
