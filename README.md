# Personal Assistant

A personal AI assistant system with multi-client support: Telegram, native macOS app, and WebSocket API.

```
┌───────────┐  ┌─────────────┐  ┌──────────┐
│  Telegram │  │   macOS     │  │  Other   │
│   (Bot)   │  │   (Swift)   │  │ Clients  │
└─────┬─────┘  └──────┬──────┘  └────┬─────┘
      │               │              │
      └───────────────┼──────────────┘
                      │
              ┌───────┴───────┐
              │ Gateway (3456) │  ← Node.js, owns Pi RPC
              │  (WebSocket)   │
              └───────┬───────┘
                      │
              ┌───────┴───────┐
              │   Pi RPC       │  ← main.jsonl session
              └───────────────┘
```

## Repository Structure

```
assistant/
├── gateway/              # Node.js gateway service
│   ├── src/
│   │   ├── index.ts          # Main entry
│   │   ├── websocket-server.ts  # WebSocket server (port 3456)
│   │   ├── broadcast.ts      # Multi-client message distribution
│   │   ├── telegram.ts       # Telegram bot
│   │   ├── telegram-client.ts # Telegram adapter for broadcast
│   │   └── ...
│   └── package.json
├── clients/
│   └── macos/            # Native macOS chat client
│       └── ChatAssistant/
│           ├── Sources/
│           │   ├── ChatAssistant.swift  # App entry
│           │   ├── ChatView.swift       # Main UI
│           │   ├── ChatService.swift    # WebSocket client
│           │   ├── Models.swift         # Data models
│           │   └── MessageViews.swift   # UI components
│           └── Package.swift
├── docs/                 # Documentation
│   ├── ARCHITECTURE.md
│   └── feature_roadmap.md
├── sessions/             # Session files (main.jsonl)
└── working_dir/          # Agent working directory
```

## Quick Start

### 1. Start the Gateway

```bash
cd gateway
npm install
npm run dev
```

The gateway starts:
- **Pi RPC** (continuous, owns main.jsonl)
- **WebSocket server** on port 3456
- **Telegram bot** (if configured)

### 2. Run the macOS Client

```bash
cd clients/macos/ChatAssistant
swift build
swift run
```

Or open in Xcode:
```bash
open clients/macos/ChatAssistant/Package.swift
```

### 3. Use Telegram (Optional)

Set up `gateway/.env`:
```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_ID=your_user_id
```

## Architecture

### Gateway (Multi-Client Hub)

The **Gateway owns the Pi RPC session**. Pi runs continuously in RPC mode. All clients connect through the Gateway:

- **Telegram bot** → receives messages, broadcasts responses
- **macOS app** → WebSocket connection to `ws://localhost:3456`
- **Future clients** → same WebSocket protocol

All connected clients see the same conversation simultaneously.

### WebSocket Protocol

Connect to `ws://localhost:3456`

**Client → Gateway:**
```json
{ "type": "prompt", "message": "hello" }
{ "type": "abort" }
{ "type": "get_state" }
```

**Gateway → Client:**
```json
{ "type": "text_delta", "data": { "content": "Hello" } }
{ "type": "tool_start", "data": { "toolCallId": "...", "toolName": "bash", "label": "$ ls" } }
{ "type": "tool_output", "data": { "toolCallId": "...", "output": "..." } }
{ "type": "done", "data": { "finalText": "..." } }
```

## Configuration

### Gateway (.env)

```env
# Required for Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_ALLOWED_USER_ID=123456789

# Optional paths
PI_SESSION_PATH=/path/to/main.jsonl
PI_CWD=/path/for/pi/working/dir

# Optional intervals
MEMORY_SCAN_INTERVAL_MS=600000    # 10 min
HEARTBEAT_INTERVAL_MS=900000      # 15 min
```

### macOS Client

Connects to `ws://localhost:3456` by default. No configuration needed.

## Key Features

- **Multi-client sync** - Telegram + macOS see same conversation
- **Real-time streaming** - Token-by-token responses via WebSocket
- **Tool visualization** - Expandable tool cards with output
- **Auto-reconnect** - Handles disconnections gracefully
- **Session persistence** - Pi owns main.jsonl, survives restarts

## Commands

| Command | Description |
|---------|-------------|
| `/status` | Show gateway status |
| `/model` | Show/change model |
| `/session` | Session stats |
| `/new` | Archive session, start fresh |

## Development

### Gateway
```bash
cd gateway
npm run dev        # Watch mode
npm run build      # TypeScript compile
npm run lint       # ESLint
```

### macOS Client
```bash
cd clients/macos/ChatAssistant
swift build
swift run
```

## Notes

- Pi must be available on PATH as `pi`
- Single-user personal project - simplicity over enterprise patterns
- Gateway binds WebSocket to localhost only (security)
- Native Pi TUI not available while Gateway is running (by design)

## Documentation

- `docs/ARCHITECTURE.md` - System design
- `docs/feature_roadmap.md` - Roadmap and bugs
- `clients/macos/README.md` - macOS client details
