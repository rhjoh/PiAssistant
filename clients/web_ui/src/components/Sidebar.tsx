import { useState, useEffect, useRef } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { useToolBlockPrefs } from '@/hooks/useToolBlockPrefs';

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
  isProcessing?: boolean;
  isConnected?: boolean;
}

export function Sidebar({
  onNewChat,
  onSwitchModel,
  models = [],
  currentModel,
  disabled,
  isProcessing = false,
  isConnected = false,
}: SidebarProps) {
  const { theme, cycleTheme } = useTheme();
  const { toolsExpandedByDefault, setToolsExpandedByDefault } = useToolBlockPrefs();
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isFoundry = theme.startsWith('foundry');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (showModelMenu && searchRef.current) {
      searchRef.current.focus();
    }
    if (!showModelMenu) {
      setModelSearch('');
    }
  }, [showModelMenu]);

  const handleModelSelect = (model: ModelInfo) => {
    onSwitchModel?.(model.provider, model.id);
    setShowModelMenu(false);
    setModelSearch('');
  };

  const filteredModels = modelSearch
    ? models.filter(m => {
        const q = modelSearch.toLowerCase();
        return (
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
        );
      })
    : models;

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
          position: 'relative',
        }}
      >
        <div style={{
          width: '28px',
          height: '28px',
          borderRadius: isFoundry ? '0' : '4px',
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
        <div
          title={isConnected ? 'Connected' : 'Disconnected'}
          style={{
            position: 'absolute',
            bottom: '6px',
            right: '10px',
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: isConnected ? 'var(--accent-success)' : 'var(--accent-danger)',
            border: `2px solid var(--bg-secondary)`,
            transition: 'background var(--transition-medium)',
          }}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-col items-center py-3 gap-2">
        {isProcessing && (
          <div
            title="Processing..."
            style={{
              width: '40px',
              height: '3px',
              background: 'var(--bg-input)',
              overflow: 'hidden',
              marginBottom: '2px',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                background: 'var(--accent-primary)',
                animation: 'sidebar-pulse 1.2s ease-in-out infinite',
                opacity: 0.6,
              }}
            />
          </div>
        )}

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
            border: '1px solid var(--border-color)',
            borderRadius: isFoundry ? '0' : 'var(--radius-md)',
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
              borderRadius: isFoundry ? '0' : 'var(--radius-md)',
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

          {showModelMenu && models.length > 0 && (
            <div
              style={{
                position: 'absolute',
                left: '100%',
                top: '0',
                marginLeft: '8px',
                width: '280px',
                maxHeight: '400px',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
                borderRadius: isFoundry ? '0' : 'var(--radius-md)',
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
              <div style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--border-color)',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: isFoundry ? '0' : 'var(--radius-sm)',
                  padding: '4px 8px',
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                  <input
                    ref={searchRef}
                    type="text"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      fontSize: '12px',
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-primary)',
                    }}
                  />
                </div>
              </div>
              <div className="scrollbar-hide" style={{ flex: 1 }}>
                {filteredModels.length === 0 ? (
                  <div style={{
                    padding: '16px 12px',
                    textAlign: 'center' as const,
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-primary)',
                  }}>
                    No models match "{modelSearch}"
                  </div>
                ) : (
                  filteredModels.map((model, index) => {
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
                          borderBottom: index < filteredModels.length - 1 ? '1px solid var(--border-color)' : 'none',
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
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Bottom actions */}
      <div
        className="flex flex-col items-center py-3 gap-2"
        style={{ borderTop: '1px solid var(--border-color)' }}
      >
        {/* Tool block expand default */}
        <button
          type="button"
          role="switch"
          aria-checked={toolsExpandedByDefault}
          aria-label="Expand tool blocks by default"
          title={toolsExpandedByDefault ? 'Tool blocks: expanded by default' : 'Tool blocks: collapsed by default'}
          onClick={() => setToolsExpandedByDefault(!toolsExpandedByDefault)}
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: `1px solid ${toolsExpandedByDefault ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderRadius: isFoundry ? '0' : 'var(--radius-md)',
            color: toolsExpandedByDefault ? 'var(--accent-primary)' : 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent-primary)';
            e.currentTarget.style.color = 'var(--accent-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = toolsExpandedByDefault ? 'var(--accent-primary)' : 'var(--border-color)';
            e.currentTarget.style.color = toolsExpandedByDefault ? 'var(--accent-primary)' : 'var(--text-secondary)';
          }}
        >
          <span
            style={{
              position: 'relative',
              width: '28px',
              height: '14px',
              borderRadius: '999px',
              background: toolsExpandedByDefault ? 'var(--accent-primary)' : 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              transition: 'background var(--transition-fast)',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '1px',
                left: toolsExpandedByDefault ? '15px' : '1px',
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: toolsExpandedByDefault ? 'var(--bg-panel)' : 'var(--text-secondary)',
                transition: 'left var(--transition-fast), background var(--transition-fast)',
              }}
            />
          </span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={cycleTheme}
          title={`Switch to ${theme === 'foundry' ? 'Foundry Day' : 'Foundry'} theme`}
          style={{
            width: '40px',
            height: '40px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid var(--border-color)',
            borderRadius: isFoundry ? '0' : 'var(--radius-md)',
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
          {theme === 'foundry' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 17l4-8 4 8H8z"></path>
              <path d="M4 17h16"></path>
              <path d="M12 9V5"></path>
            </svg>
          ) : (
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
          )}
        </button>
      </div>
    </div>
  );
}
