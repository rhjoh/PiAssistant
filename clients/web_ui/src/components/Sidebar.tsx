import { useState, useEffect, useRef } from 'react';
import { useTheme } from '@/hooks/useTheme';

interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

interface SidebarProps {
  onNewChat: () => void;
  onSwitchModel?: (provider: string, modelId: string) => void;
  models?: ModelInfo[];
  currentModel?: ModelInfo;
  disabled?: boolean;
}

export function Sidebar({ 
  onNewChat, 
  onSwitchModel,
  models = [],
  currentModel,
  disabled 
}: SidebarProps) {
  const { theme, toggleTheme } = useTheme();
  const [showModelMenu, setShowModelMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isOps = theme === 'ops';

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleModelSelect = (model: ModelInfo) => {
    onSwitchModel?.(model.provider, model.id);
    setShowModelMenu(false);
  };

  return (
    <div 
      className="flex flex-col h-full select-none"
      style={{ 
        width: '56px',
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-color)',
      }}
    >
      {/* Logo */}
      <div 
        style={{ 
          height: '44px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: '4px',
          background: 'var(--accent-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-inverse)',
          fontSize: '14px',
          fontWeight: 700,
          fontFamily: 'var(--font-primary)',
        }}>
          π
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col items-center py-3 gap-2">
        {/* New Chat */}
        <button
          onClick={onNewChat}
          disabled={disabled}
          title="New chat"
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${isOps ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderRadius: 'var(--radius-md)',
            color: 'var(--accent-primary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!disabled) {
              e.currentTarget.style.background = 'var(--accent-primary-dim)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>

        {/* Model Selector */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setShowModelMenu(!showModelMenu)}
            disabled={disabled || models.length === 0}
            title={currentModel ? `Model: ${currentModel.name}` : 'Select model'}
            style={{
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: showModelMenu ? 'var(--accent-primary-dim)' : 'transparent',
              border: `1px solid ${showModelMenu ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              borderRadius: 'var(--radius-md)',
              color: models.length === 0 ? 'var(--text-muted)' : 'var(--accent-primary)',
              cursor: disabled || models.length === 0 ? 'not-allowed' : 'pointer',
              opacity: disabled || models.length === 0 ? 0.5 : 1,
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              if (!disabled && models.length > 0 && !showModelMenu) {
                e.currentTarget.style.borderColor = 'var(--accent-primary)';
              }
            }}
            onMouseLeave={(e) => {
              if (!showModelMenu) {
                e.currentTarget.style.borderColor = 'var(--border-color)';
              }
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
              <path d="M2 17l10 5 10-5"></path>
              <path d="M2 12l10 5 10-5"></path>
            </svg>
          </button>

          {/* Model Dropdown */}
          {showModelMenu && models.length > 0 && (
            <div
              style={{
                position: 'absolute',
                left: '100%',
                top: '0',
                marginLeft: '8px',
                width: '280px',
                maxHeight: '400px',
                overflow: 'auto',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 100,
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border-color)',
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-primary)',
                }}
              >
                Select Model
              </div>
              {models.map((model, index) => {
                const isCurrent = currentModel?.provider === model.provider && 
                                  currentModel?.id === model.id;
                return (
                  <button
                    key={`${model.provider}-${model.id}`}
                    onClick={() => handleModelSelect(model)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      width: '100%',
                      padding: '10px 12px',
                      textAlign: 'left',
                      background: isCurrent ? 'var(--accent-primary-dim)' : 'transparent',
                      border: 'none',
                      borderBottom: index < models.length - 1 ? '1px solid var(--border-color)' : 'none',
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent) {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                    }}>
                      <span style={{
                        fontSize: '13px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        fontFamily: 'var(--font-primary)',
                      }}>
                        {model.name}
                      </span>
                      {isCurrent && (
                        <span style={{
                          marginLeft: 'auto',
                          fontSize: '11px',
                          color: 'var(--accent-primary)',
                          fontFamily: 'var(--font-primary)',
                        }}>
                          ●
                        </span>
                      )}
                    </div>
                    <span style={{
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-primary)',
                    }}>
                      {model.provider}/{model.id}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom actions */}
      <div 
        className="flex flex-col items-center py-3 gap-2"
        style={{ borderTop: '1px solid var(--border-color)' }}
      >
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={isOps ? 'Switch to SaaS theme' : 'Switch to Ops theme'}
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-primary)';
            e.currentTarget.style.color = 'var(--accent-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-color)';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          {isOps ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"></circle>
              <line x1="12" y1="1" x2="12" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="23"></line>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
              <line x1="1" y1="12" x2="3" y2="12"></line>
              <line x1="21" y1="12" x2="23" y2="12"></line>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
