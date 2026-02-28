# Pi Assistant Web UI

A modern React-based web interface for Pi Assistant, built with **shadcn/ui**, **Tailwind CSS**, and **TypeScript**.

## Features

- **Modern Stack**: React 18 + TypeScript + Vite + Tailwind CSS
- **Beautiful UI**: shadcn/ui components with dark theme
- **Real-time Streaming**: WebSocket connection to gateway
- **Slash Commands**: IntelliSense-style command popup (`/new`, `/model`, `/session`, etc.)
- **Message Types**: Text, thinking blocks, tool calls/results, images
- **Auto-reconnect**: Automatic reconnection with exponential backoff
- **Responsive**: Works on desktop and mobile

## Development

```bash
# Install dependencies
npm install

# Start dev server (Vite)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Start production server
npm run build && npm run server
```

The dev server runs on `http://localhost:5173` by default.

## Configuration

The WebSocket URL is set to `ws://localhost:3456` (same as the gateway). Edit `src/App.tsx` if your gateway runs on a different port.

## Architecture

```
web_ui/
├── src/
│   ├── components/
│   │   ├── ui/           # shadcn/ui components
│   │   ├── ChatHeader.tsx
│   │   ├── ChatInput.tsx
│   │   └── MessageBubble.tsx
│   ├── hooks/
│   │   └── useWebSocket.ts
│   ├── lib/
│   │   └── utils.ts
│   ├── types.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── server/
│   └── index.ts          # Express server for production
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## WebSocket Protocol

Same as the macOS client - connects directly to the gateway WebSocket server.

## License

Private
