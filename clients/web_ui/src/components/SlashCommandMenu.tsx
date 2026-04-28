import { useState, useEffect, useRef, useMemo } from 'react';

interface Command {
  name: string;
  description: string;
  args?: string;
}

const COMMANDS: Command[] = [
  { name: 'model', description: 'Show/switch model', args: 'list | <number>' },
  { name: 'session', description: 'Show session stats' },
  { name: 'new', description: 'Archive & start new session' },
  { name: 'status', description: 'Show gateway status' },
  { name: 'clear', description: 'Clear the chat view' },
];

interface SlashCommandMenuProps {
  query: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ query, onSelect, onClose }: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = query.trim();
  const [commandQuery, ...argQueryParts] = trimmedQuery.length > 0
    ? trimmedQuery.split(/\s+/)
    : [''];
  const argsQuery = argQueryParts.join(' ');
  const inArgsMode = argsQuery.length > 0;

  // Filter commands based on query (fuzzy match)
  const filteredCommands = useMemo(() => {
    if (!commandQuery) return COMMANDS;
    const lowerQuery = commandQuery.toLowerCase();
    return COMMANDS.filter(cmd => 
      cmd.name.toLowerCase().includes(lowerQuery) ||
      cmd.description.toLowerCase().includes(lowerQuery)
    );
  }, [commandQuery]);

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (inArgsMode && e.key === 'Enter') {
        // Let InputArea submit full command with arguments
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => 
            prev < filteredCommands.length - 1 ? prev + 1 : prev
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => prev > 0 ? prev - 1 : 0);
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            const cmd = filteredCommands[selectedIndex];
            onSelect(`/${cmd.name}${cmd.args ? ' ' : ''}`);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredCommands, selectedIndex, onSelect, onClose, inArgsMode]);

  // Scroll selected into view
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filteredCommands.length === 0) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: '100%',
          left: '0',
          marginBottom: '8px',
          padding: '12px 16px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          color: 'var(--text-secondary)',
          fontSize: '13px',
          zIndex: 50,
        }}
      >
        No commands found
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="scrollbar-hide"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: '0',
        marginBottom: '8px',
        width: '320px',
        maxHeight: '280px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 50,
      }}
    >
      {filteredCommands.map((cmd, index) => (
        <button
          key={cmd.name}
          onClick={() => onSelect(`/${cmd.name}${cmd.args ? ' ' : ''}`)}
          onMouseEnter={() => setSelectedIndex(index)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            width: '100%',
            padding: '10px 16px',
            textAlign: 'left',
            background: index === selectedIndex ? 'var(--accent-primary-dim)' : 'transparent',
            border: 'none',
            borderBottom: index < filteredCommands.length - 1 ? '1px solid var(--border-color)' : 'none',
            cursor: 'pointer',
            fontFamily: 'var(--font-primary)',
            fontSize: '13px',
            color: 'var(--text-primary)',
          }}
        >
          <span
            style={{
              padding: '2px 8px',
              background: 'var(--bg-input)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-primary)',
              fontSize: '12px',
              color: 'var(--accent-primary)',
              fontWeight: 500,
            }}
          >
            /{cmd.name}
          </span>
          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            {cmd.description}
          </span>
          {cmd.args && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '12px',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-primary)',
              }}
            >
              {cmd.args}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
