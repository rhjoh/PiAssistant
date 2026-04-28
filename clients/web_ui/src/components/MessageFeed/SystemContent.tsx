export function SystemContent({ content }: { content: string }) {
  return (
    <div style={{
      fontSize: '13px',
      color: 'var(--accent-danger)',
      fontFamily: 'var(--font-primary)',
      padding: '12px 16px',
      borderLeft: '2px solid var(--accent-danger)',
      background: 'var(--bg-input)',
    }}>
      {content}
    </div>
  );
}
