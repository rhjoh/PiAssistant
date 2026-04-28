import { useState, useCallback, useMemo } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { SlashCommandMenu } from './SlashCommandMenu';
import type { UploadImage } from '@/types';

interface InputAreaProps {
  onSend: (message: string, images?: UploadImage[]) => void;
  onAbort: () => void;
  isProcessing: boolean;
  disabled?: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}

export function InputArea({ onSend, onAbort, isProcessing, disabled, textareaRef }: InputAreaProps) {
  const { theme } = useTheme();
  const isFoundry = theme.startsWith('foundry');

  const [input, setInput] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [pastedImages, setPastedImages] = useState<UploadImage[]>([]);

  const commandQuery = useMemo(() => {
    if (!showCommands) return '';
    const match = input.match(/^\/(.+)$/);
    return match ? match[1] : '';
  }, [input, showCommands]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const hasSlashArgs = /^\/\S+\s+.+/.test(input.trim());
    if (showCommands && !hasSlashArgs && (e.key === 'Enter' || e.key === 'Escape' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    setShowCommands(value.startsWith('/'));
  };

  const handleCommandSelect = (command: string) => {
    setInput(command + ' ');
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const handleCommandClose = () => {
    setShowCommands(false);
  };

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if ((!trimmed && pastedImages.length === 0) || disabled) return;
    onSend(trimmed, pastedImages.length > 0 ? pastedImages : undefined);
    setInput('');
    setPastedImages([]);
    setShowCommands(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  }, [input, pastedImages, disabled, onSend, textareaRef]);

  const handleAbort = useCallback(() => {
    onAbort();
  }, [onAbort]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const base64 = event.target?.result as string;
            if (base64) {
              setPastedImages(prev => [...prev, {
                dataUrl: base64,
                mimeType: item.type || blob.type || 'image/png',
                size: blob.size,
              }]);
            }
          };
          reader.readAsDataURL(blob);
        }
      }
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setPastedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const inputContainerStyle = isFoundry ? {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    background: 'var(--bg-input)',
    border: `1px solid ${isFocused ? 'var(--border-color-strong)' : 'var(--border-color)'}`,
    borderRadius: '0',
    padding: '6px 10px',
    boxShadow: 'none',
    transition: 'all 0.1s ease',
  } : {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    background: 'var(--bg-input)',
    border: `1px solid ${isFocused ? 'var(--accent-primary)' : 'var(--border-color)'}`,
    borderRadius: 'var(--radius-lg)',
    padding: '4px 8px',
    boxShadow: isFocused ? '0 0 0 1px var(--accent-primary), 0 2px 8px rgba(0,0,0,0.06)' : 'var(--shadow-sm)',
    transition: 'all 0.15s ease',
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border-color)',
        background: isFoundry ? 'var(--statusbar-bg)' : 'var(--bg-primary)',
        padding: isFoundry ? '10px 40px' : '12px 40px',
      }}
    >
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={inputContainerStyle}>
          <div style={{ flex: 1, position: 'relative' }}>
            {showCommands && (
              <SlashCommandMenu
                query={commandQuery}
                onSelect={handleCommandSelect}
                onClose={handleCommandClose}
              />
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onPaste={handlePaste}
              placeholder={isProcessing
                ? (isFoundry ? 'TYPE TO STEER OR /ABORT' : 'Type to steer, or press Esc to abort...')
                : (isFoundry ? 'ENTER COMMAND' : 'Message Pi...')
              }
              disabled={disabled}
              rows={1}
              style={{
                width: '100%',
                minHeight: '22px',
                maxHeight: '200px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: isFoundry ? '13px' : '14px',
                color: 'var(--text-primary)',
                caretColor: 'var(--accent-primary)',
                fontFamily: 'var(--font-primary)',
                lineHeight: '1.4',
                resize: 'none',
                padding: isFoundry ? '4px 0' : '2px 2px',
                fontWeight: 400,
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />
          </div>

          {isProcessing ? (
            <button
              onClick={handleAbort}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                height: '36px',
                background: 'transparent',
                border: '1px solid var(--accent-danger)',
                borderRadius: isFoundry ? '0' : 'var(--radius-md)',
                color: isFoundry ? 'var(--accent-danger)' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s',
                padding: '0 12px',
                fontFamily: 'var(--font-primary)',
                fontSize: isFoundry ? '10px' : '12px',
                letterSpacing: isFoundry ? '0.1em' : '0',
                textTransform: isFoundry ? 'uppercase' : 'none',
              }}
              title="Abort running request"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)';
                e.currentTarget.style.color = 'var(--accent-danger)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = isFoundry ? 'var(--accent-danger)' : 'var(--text-secondary)';
              }}
            >
              <div style={{
                width: '14px',
                height: '14px',
                border: '2px solid var(--border-color)',
                borderTopColor: 'var(--accent-primary)',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }} />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" />
              </svg>
              {isFoundry ? 'ABORT' : 'Abort'}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!input.trim() && pastedImages.length === 0) || disabled}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                background: ((!input.trim() && pastedImages.length === 0) || disabled)
                  ? 'transparent'
                  : isFoundry
                    ? 'transparent'
                    : 'var(--accent-primary)',
                border: isFoundry
                  ? `1px solid ${((!input.trim() && pastedImages.length === 0) || disabled) ? 'var(--border-color)' : 'var(--accent-primary)'}`
                  : 'none',
                padding: isFoundry ? '10px 16px' : '8px',
                fontSize: isFoundry ? '10px' : '13px',
                fontWeight: isFoundry ? 400 : 600,
                textTransform: isFoundry ? 'uppercase' : 'none',
                letterSpacing: isFoundry ? '0.1em' : '0',
                color: ((!input.trim() && pastedImages.length === 0) || disabled)
                  ? 'var(--text-muted)'
                  : isFoundry
                    ? 'var(--accent-primary)'
                    : 'var(--text-inverse)',
                cursor: ((!input.trim() && pastedImages.length === 0) || disabled) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-primary)',
                borderRadius: isFoundry ? '0' : 'var(--radius-md)',
                transition: 'all var(--transition-fast)',
                minWidth: '32px',
                height: '32px',
              }}
            >
              {isFoundry ? 'TRANSMIT' : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          )}
        </div>

        {pastedImages.length > 0 && (
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            {pastedImages.map((img, idx) => (
              <div key={idx} style={{ position: 'relative' }}>
                <img
                  src={img.dataUrl}
                  alt={`Pasted ${idx + 1}`}
                  style={{
                    width: '80px',
                    height: '80px',
                    objectFit: 'cover',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-color)'
                  }}
                />
                <button
                  onClick={() => removeImage(idx)}
                  style={{
                    position: 'absolute',
                    top: '-4px',
                    right: '-4px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: 'var(--accent-danger)',
                    border: 'none',
                    color: 'white',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            marginTop: isFoundry ? '6px' : '8px',
            fontSize: isFoundry ? '9px' : '12px',
            letterSpacing: isFoundry ? '0.12em' : '0',
            textTransform: isFoundry ? 'uppercase' : 'none',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-primary)',
            fontWeight: isFoundry ? 400 : 450,
          }}
        >
          {disabled ? (
            isFoundry ? 'CONN DROP // RECONNECTING' : 'Reconnecting to gateway...'
          ) : isProcessing ? (
            isFoundry ? 'PROCESSING // TYPE TO STEER // ESC TO ABORT' : 'Processing... Press Esc to stop'
          ) : (
            isFoundry ? 'READY // ENTER TO TRANSMIT // PASTE IMAGE' : 'Enter to send · Shift+Enter for new line · Paste image'
          )}
        </div>
      </div>
    </div>
  );
}
