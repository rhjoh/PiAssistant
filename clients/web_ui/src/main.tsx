// Note: StrictMode removed — double-mounting causes WebSocket connect/disconnect races
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ThemeProvider } from '@/hooks/useTheme'
import { ToolBlockPrefsProvider } from '@/hooks/useToolBlockPrefs'
import './index.css'

// Debug logging for unexpected refreshes
console.log('[App] Initializing at', new Date().toISOString())
console.log('[App] Previous session?', sessionStorage.getItem('app_session'))

sessionStorage.setItem('app_session', Date.now().toString())

window.addEventListener('beforeunload', () => {
  console.log('[App] Page unloading at', new Date().toISOString())
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeProvider>
      <ToolBlockPrefsProvider>
        <App />
      </ToolBlockPrefsProvider>
    </ThemeProvider>
  </ErrorBoundary>,
)
