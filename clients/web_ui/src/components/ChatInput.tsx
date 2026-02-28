import { useState, useRef, useCallback } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { COMMANDS } from '@/types';
import { cn } from '@/lib/utils';

interface ChatInputProps {
  onSend: (message: string) => void;
  onAbort: () => void;
  isProcessing: boolean;
  disabled?: boolean;
}

export function ChatInput({ onSend, onAbort, isProcessing, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    if (value.startsWith('/')) {
      setShowCommands(true);
      setSelectedIndex(0);
    } else {
      setShowCommands(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showCommands) {
      const filtered = getFilteredCommands();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          selectCommand(filtered[selectedIndex].name);
        }
      } else if (e.key === 'Escape') {
        setShowCommands(false);
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getFilteredCommands = () => {
    const query = input.slice(1).toLowerCase();
    return COMMANDS.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.desc.toLowerCase().includes(query)
    );
  };

  const selectCommand = (command: string) => {
    setInput(command + ' ');
    setShowCommands(false);
    inputRef.current?.focus();
  };

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setInput('');
    setShowCommands(false);
  }, [input, disabled, onSend]);

  const handleAbort = useCallback(() => {
    onAbort();
  }, [onAbort]);

  const filteredCommands = getFilteredCommands();

  return (
    <div className="border-t bg-card px-4 py-3">
      <div className="mx-auto max-w-5xl">
        <div className="relative">
          {showCommands && filteredCommands.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 rounded border bg-background shadow-sm">
              {filteredCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  onClick={() => selectCommand(cmd.name)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted',
                    idx === selectedIndex && 'bg-muted'
                  )}
                >
                  <span className="font-medium">{cmd.name}</span>
                  <span className="text-muted-foreground">{cmd.desc}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={isProcessing ? 'AI is thinking...' : 'Message...'}
              disabled={disabled || isProcessing}
              rows={1}
              className="min-h-[40px] flex-1 resize-none rounded border bg-background px-3 py-2 text-sm outline-none focus:border-foreground disabled:opacity-50"
              style={{ height: 'auto', minHeight: '40px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />

            {isProcessing ? (
              <Button onClick={handleAbort} variant="outline" size="icon">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={handleSend} disabled={!input.trim() || disabled} size="icon">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
