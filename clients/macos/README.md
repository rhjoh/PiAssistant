# ChatAssistant macOS Client

Native macOS chat client for the Personal Assistant system.

## Features

- **Real-time streaming** - WebSocket connection to gateway for token-by-token responses
- **Tool visualization** - Expandable tool call cards with icons and arguments
- **Multi-client sync** - Works alongside Telegram, both see the same conversation
- **Auto-reconnect** - Handles connection drops and reconnects automatically
- **Clean UI** - Native SwiftUI with message bubbles, timestamps, and typing indicators

## Build & Run

```bash
cd clients/macos/ChatAssistant
swift build
swift run
```

Or open in Xcode:
```bash
open Package.swift
```

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   ChatAssistant │ ◄────────────────► │  Gateway (3456) │
│    (macOS App)  │                    │   (Node.js)     │
└─────────────────┘                    └────────┬────────┘
                                                │
                                         ┌──────┴──────┐
                                         │   Pi RPC    │
                                         │  (main.jsonl)│
                                         └─────────────┘
```

## WebSocket Protocol

See `gateway/src/types-ws.ts` for full protocol specification.

Key message types:
- `prompt` - Send user message
- `text_delta` - Receive streaming text
- `tool_start/end` - Tool execution lifecycle
- `done` - Response complete

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ↵ Enter | Send message |
| ⌘ + . | Cancel streaming |

## Development

The client uses:
- `URLSessionWebSocketTask` for WebSocket communication
- `@MainActor` for thread-safe UI updates
- `ObservableObject` pattern for state management

## Todo

- [ ] History loading on connect
- [ ] Slash command autocomplete (/new, /model, /status)
- [ ] System notifications
- [ ] Window position persistence
- [ ] Image display support
