import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [
    react({
      // Disable React Refresh for stable WebSocket connections
      include: '**/*.tsx',
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Disable HMR to prevent constant reloads
    hmr: false,
    // Auto-open browser
    open: true,
  },
})