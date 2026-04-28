import { ChatMessage } from '@/types';
import { formatTime } from './utils';

export function MetadataColumn({ msg }: { msg: ChatMessage }) {
  const getRoleLabel = () => {
    if (msg.role === 'user') return { text: 'USR', color: 'var(--accent-secondary)' };
    if (msg.role === 'system') return { text: 'SYS', color: 'var(--accent-danger)' };
    return { text: 'AST', color: 'var(--accent-primary)' };
  };

  const role = getRoleLabel();

  return (
    <div style={{
      textAlign: 'left',
      padding: '10px 12px',
      borderRight: '1px solid var(--border-color)',
      background: 'var(--bg-input)',
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        alignItems: 'flex-start',
      }}>
        <span
          className="foundry-work-order"
          style={{ color: role.color, borderColor: role.color }}
        >
          {role.text}
        </span>
        <span style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-primary)',
          letterSpacing: '0.04em',
        }}>
          {formatTime(msg.timestamp || Date.now())}
        </span>
        {msg.isStreaming && (
          <span style={{
            width: '5px',
            height: '5px',
            background: 'var(--accent-primary)',
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
        )}
      </div>
    </div>
  );
}
