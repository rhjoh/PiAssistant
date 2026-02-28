import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ThemeProvider } from '@/hooks/useTheme'
import './index.css'

// Debug logging for unexpected refreshes
console.log('[App] Initializing at', new Date().toISOString())
console.log('[App] Previous session?', sessionStorage.getItem('app_session'))

sessionStorage.setItem('app_session', Date.now().toString())

window.addEventListener('beforeunload', () => {
  console.log('[App] Page unloading at', new Date().toISOString())
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
