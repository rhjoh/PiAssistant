import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    console.error('[ErrorBoundary] Caught error:', error);
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Error details:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#070809',
          color: '#ef4444',
          fontFamily: "'IBM Plex Mono', monospace",
          padding: '20px'
        }}>
          <div style={{ fontSize: '14px', marginBottom: '16px' }}>
            [SYSTEM ERROR]
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8', maxWidth: '600px' }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '24px',
              padding: '10px 20px',
              background: 'transparent',
              border: '1px solid #4ade80',
              color: '#4ade80',
              cursor: 'pointer',
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: '11px'
            }}
          >
            RELOAD PAGE
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
