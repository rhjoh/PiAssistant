# PiAssistant Architecture

**Last Updated:** 2026-02-22

## Overview

PiAssistant is a personal AI assistant system with multi-client support. The Gateway owns a persistent Pi RPC session and broadcasts conversation state to all connected clients (Telegram, macOS native app, Pi TUI via bridge).

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Telegram   │  │   macOS     │  │  Pi TUI     │
│   (Bot)     │  │   (Swift)   │  │  (Bridge)   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
              ┌─────────┴──────────┐
              │   Gateway (3456)   │  ← Node.js, owns Pi RPC
              │  - WebSocket srv   │
              │  - Broadcast mgr   │
              │  - Telegram bot    │
              │  - Memory watcher  │
              │  - Heartbeat       │
              └─────────┬──────────┘
                        │
              ┌─────────┴──────────┐
              │   Pi RPC Agent     │  ← main.jsonl session
              │   (glm-4.7 / etc)  │
              └────────────────────┘
```

## Core Principles

1. **Gateway owns the session** - Pi RPC runs continuously, no handoff/lock complexity
2. **Multi-client sync** - All clients see the same conversation simultaneously
3. **Broadcast architecture** - Events flow: Pi → Gateway → BroadcastManager → All Clients
4. **Self-improving** - Agent can modify its own codebase via tools

## Components

### 1. Gateway (Node.js)

**Location:** `gateway/src/`

The central hub. Owns the Pi RPC process, manages WebSocket connections, and coordinates all features.

**Key Modules:**

| File | Responsibility |
|------|----------------|
| `index.ts` | Entry point, service initialization, lifecycle |
| `pi-rpc.ts` | Pi RPC client wrapper, event streaming |
| `websocket-server.ts` | WebSocket server on port 3456, client routing |
| `broadcast.ts` | BroadcastManager - distributes events to all clients |
| `telegram-client.ts` | Telegram adapter for BroadcastManager |
| `telegram.ts` | Telegram bot (grammY), command handlers |
| `session-manager.ts` | Session archival, `/new` command, compaction events |
| `memory-watcher.ts` | Background extraction to memory.md | 
| `heartbeat.ts` | Periodic proactive prompts |
| `image-storage.ts` | Base64 image persistence to disk |
| `prompt-handler.ts` | Tool output formatting, response streaming |

**Startup Flow:**
1. Load config from `.env`
2. Initialize ImageStorage (ensures `~/assistant_main/images/` exists)
3. Start Pi RPC process (continuous mode)
4. Start WebSocket server (localhost:3456)
5. Start Telegram bot (if configured)
6. Start Memory Watcher (background LLM extraction)
7. Start Heartbeat scheduler

### 2. Pi RPC Process

**Invocation:** `pi --mode rpc --session ~/assistant_main/sessions/main.jsonl`

The LLM agent process. Gateway spawns and owns this process. It loads the session file and maintains conversation state.

**Communication:**
- Gateway sends: `{"type": "prompt", "message": "..."}` or `{"type": "prompt_with_images", ...}`
- Pi streams events: `text_delta`, `thinking_start`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `done`, `error`

**Session File:** `~/assistant_main/sessions/main.jsonl`
- JSONL format, one entry per line
- Contains messages, tool calls, tool results, model changes
- Automatic compaction when context fills (triggers archival)

### 3. WebSocket Protocol

**Endpoint:** `ws://localhost:3456`

All non-Telegram clients connect here. The server routes by path:
- `/` - Regular clients (macOS app)
- `/pi-client` - Pi TUI via bridge extension

**Client → Gateway:**
```json
{ "type": "prompt", "message": "hello" }
{ "type": "prompt_with_images", "message": "describe this", "images": [...] }
{ "type": "abort" }
{ "type": "get_state" }
{ "type": "slash_command", "command": "new" }
```

**Gateway → Client:**
```json
{ "type": "text_delta", "data": { "content": "Hello" } }
{ "type": "thinking_start", "data": { "id": "..." } }
{ "type": "thinking_delta", "data": { "id": "...", "content": "..." } }
{ "type": "tool_start", "data": { "toolCallId": "...", "toolName": "bash", "label": "$ ls" } }
{ "type": "tool_output", "data": { "toolCallId": "...", "output": "..." } }
{ "type": "tool_end", "data": { "toolCallId": "..." } }
{ "type": "image", "data": { "mimeType": "image/png", "data": "base64..." } }
{ "type": "done", "data": { "finalText": "..." } }
{ "type": "error", "data": { "message": "..." } }
{ "type": "history", "data": { "messages": [...] } }
{ "type": "clear" }
```

---

## Endpoints

### WebSocket Endpoints

| Endpoint | Path | Purpose | Client Type |
|----------|------|---------|-------------|
| `ws://localhost:3456/` | `/` | Standard client connection | macOS app |
| `ws://localhost:3456/pi-client` | `/pi-client` | Pi TUI bridge connection | Pi TUI extension |

**Connection Behavior:**
- Server binds to `localhost:3456` only (security)
- Supports multiple simultaneous connections
- Each connection receives full broadcast stream
- On connect: Server sends session history via `history` message

### Message Types (Client → Gateway)

| Type | Payload | Description |
|------|---------|-------------|
| `prompt` | `{ message: string }` | Send text message to agent |
| `prompt_with_images` | `{ message: string, images: ImageAttachment[] }` | Send message with images |
| `abort` | `{}` | Abort current agent turn |
| `get_state` | `{}` | Request current session state |
| `slash_command` | `{ command: string }` | Execute command (`new`, `model`, etc.) |

**ImageAttachment:**
```typescript
{
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp",
  data: "base64...",  // base64 encoded image data
  name?: string       // optional filename
}
```

### Message Types (Gateway → Client)

| Type | Payload | Description |
|------|---------|-------------|
| `text_delta` | `{ content: string }` | Streaming text chunk |
| `thinking_start` | `{ id: string }` | Thinking block started |
| `thinking_delta` | `{ id: string, content: string }` | Thinking content update |
| `thinking_end` | `{ id: string }` | Thinking block complete |
| `tool_start` | `{ toolCallId: string, toolName: string, label: string }` | Tool execution started |
| `tool_output` | `{ toolCallId: string, output: string }` | Tool output chunk |
| `tool_end` | `{ toolCallId: string }` | Tool execution complete |
| `image` | `{ mimeType: string, data: string }` | Image data (base64) |
| `done` | `{ finalText: string }` | Turn complete, final text |
| `error` | `{ message: string }` | Error occurred |
| `history` | `{ messages: Message[] }` | Full session history on connect |
| `clear` | `{}` | Clear conversation (after `/new`) |

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message |
| `/status` | Show gateway and Pi status |
| `/model` | Show current model or list available |
| `/model <n>` | Switch to model by number |
| `/session` | Show session stats and context info |
| `/new` | Archive session and start fresh |

**Note:** Telegram commands are registered via `bot.api.setMyCommands()` on startup.

### Pi RPC Commands (Internal)

Gateway → Pi RPC via stdin/stdout JSON protocol:

| Command | Description |
|---------|-------------|
| `prompt` | Send user message, stream response |
| `prompt_with_images` | Send message with image attachments |
| `steer` | Send system steering message |
| `abort` | Abort current generation |
| `get_state` | Get current model, stats |
| `get_session_stats` | Get cumulative token/cost stats |
| `new_session` | Archive and start new session |
| `set_model` | Change LLM model |

### File System Paths

| Path | Purpose | Config Var |
|------|---------|------------|
| `~/assistant_main/sessions/main.jsonl` | Active session file | `PI_SESSION_PATH` |
| `~/assistant_main/sessions/archived/` | Archived sessions | - |
| `~/assistant_main/images/` | Stored image files | - |
| `~/assistant_main/memory.md` | Extracted memories | - |
| `~/assistant_main/yesterday.md` | Recent context | - |
| `gateway/prompts/memory-prompt.md` | Memory extraction prompt | - |
| `gateway/prompts/heartbeat.md` | Heartbeat prompt template | - |

### 4. BroadcastManager

**Location:** `gateway/src/broadcast.ts`

Central message distribution. All Pi events flow through here to reach all connected clients.

**Clients:**
- `TelegramClient` - Sends to Telegram bot API
- `WebSocketClient` - Sends to macOS app
- `PiClientHandler` - Sends to Pi TUI bridge

**Features:**
- Serializes Pi events to maintain order
- Throttles Telegram edits (rate limit handling)
- Formats tool output for display
- Splits long responses for Telegram 4096 char limit

### 5. macOS Client

**Location:** `clients/macos/ChatAssistant/`

Native SwiftUI app. Connects to Gateway via WebSocket.

**Key Files:**
- `ChatView.swift` - Main UI, message list, input, scroll behavior
- `ChatService.swift` - WebSocket client, message parsing
- `MessageViews.swift` - Message bubbles, tool cards, thinking blocks
- `Models.swift` - Data models, theme definitions

**Features:**
- Real-time streaming display
- Tool call visualization (expandable cards)
- Image display (drag/drop, paste, file drop)
- Slash command popup (`/new`, `/model`, `/status`)
- Zoom support (Cmd++, Cmd+-)
- Auto-scroll with sticky positioning
- Theme toggle (Standard / Terminal)

### 6. Pi TUI Bridge

**Location:** `~/.pi/agent/extensions/gateway-bridge.ts`

Extension that allows Pi TUI to connect to Gateway as a client. Pi TUI becomes a "dumb" UI - Gateway owns the agent loop.

**Usage:**
```bash
# In Pi TUI
pi extensions enable gateway-bridge
pi --provider gateway-bridge
```

**Flow:**
1. Bridge connects to `ws://localhost:3456/pi-client`
2. User types in TUI → bridge forwards to Gateway
3. Gateway runs Pi RPC → streams events back
4. Bridge translates Gateway events → Pi native events
5. TUI renders natively (tool blocks, thinking, etc.)

### 7. Memory System

**Components:**
- **Session archival** - `SessionManager` archives to `sessions/archived/` on compaction or `/new`
- **Memory Watcher** - Background process parses session, extracts facts via LLM to `memory.md`
- **Yesterday rotation** - `yesterday.md` keeps last 3 days, rotated daily
- **Context injection** - Agent instructed to read `memory.md` and `yesterday.md` on start

**Files:**
- `~/assistant_main/memory.md` - Long-term extracted memories
- `~/assistant_main/yesterday.md` - Recent context (rotated)
- `gateway/src/memory-watcher.ts` - Extraction logic
- `gateway/prompts/memory-prompt.md` - LLM extraction prompt
- `gateway/prompts/yesterday-prompt.md` - Daily summary prompt

### 8. Heartbeat

**Location:** `gateway/src/heartbeat.ts`

Periodic proactive messaging. Injects a prompt on interval for the agent to check tasks/reminders.

**Configuration:**
- `HEARTBEAT_INTERVAL_MS` (default: 15 minutes)
- `heartbeat.md` prompt template with `{{TIME}}` placeholder

**Behavior:**
- Agent can respond with actions or `[[NO_ACTION]]`
- `[[NO_ACTION]]` responses are filtered (not sent to clients)
- Real responses broadcast to all clients

### 9. Image Storage

**Location:** `gateway/src/image-storage.ts`

Manages images to keep session files small.

**Behavior:**
- Incoming images (base64) saved to `~/assistant_main/images/YYYYMMDD-HHMMSS-{hash}.{ext}`
- Session stores `{type: "image", path: "/full/path"}` instead of base64
- WebSocket sends file paths; clients load on demand
- `sanitizeForHistory()` converts base64 in old sessions to paths

## Data Flows

### Normal Message Flow
```
User (Telegram/macOS/TUI)
    ↓
Gateway receives (Telegram bot or WebSocket)
    ↓
Pi RPC prompt()
    ↓
Pi streams events (text_delta, tool_start, tool_output, tool_end, done)
    ↓
BroadcastManager distributes to all connected clients
    ↓
Telegram: Edit message in place
macOS: Update SwiftUI state
TUI: Render native blocks
```

### Session Archival Flow
```
User sends /new (or auto-compaction triggers)
    ↓
SessionManager.archiveSession()
    ↓
Copy main.jsonl → sessions/archived/main_TIMESTAMP.jsonl
    ↓
Pi RPC newSession() (truncates main.jsonl)
    ↓
Broadcast "clear" to all clients
    ↓
Telegram notification: "Session archived"
```

### Image Flow
```
User pastes image into macOS client
    ↓
Convert to base64, send "prompt_with_images"
    ↓
Gateway: ImageStorage.saveImage() → disk
    ↓
Send to Pi: base64 data (for LLM)
    ↓
Pi processes, may generate output image
    ↓
Gateway: Save output image, broadcast path to clients
    ↓
Clients display from file path
```

## File Structure

```
~/Development/assistant/
├── gateway/
│   ├── src/
│   │   ├── index.ts              # Main entry
│   │   ├── websocket-server.ts   # WS server, routing
│   │   ├── pi-client-handler.ts  # Pi TUI bridge handler
│   │   ├── broadcast.ts          # Multi-client distribution
│   │   ├── telegram-client.ts    # Telegram broadcast adapter
│   │   ├── telegram.ts           # Telegram bot, commands
│   │   ├── pi-rpc.ts             # Pi RPC wrapper
│   │   ├── session-manager.ts    # Session archival
│   │   ├── memory-watcher.ts     # Background extraction
│   │   ├── heartbeat.ts          # Proactive messaging
│   │   ├── image-storage.ts      # Image persistence
│   │   ├── prompt-handler.ts     # Tool formatting
│   │   ├── types-ws.ts           # WebSocket type definitions
│   │   └── config.ts             # Environment config
│   ├── prompts/
│   │   ├── memory-prompt.md      # Memory extraction prompt
│   │   └── yesterday-prompt.md   # Daily summary prompt
│   └── package.json
├── clients/
│   └── macos/
│       └── ChatAssistant/
│           ├── Sources/
│           │   ├── ChatAssistant.swift
│           │   ├── ChatView.swift
│           │   ├── ChatService.swift
│           │   ├── Models.swift
│           │   └── MessageViews.swift
│           └── Package.swift
├── docs/
│   ├── ARCHITECTURE.md           # This file
│   └── ROADMAP.md                # Feature roadmap and specs
└── tasks/                        # Active implementation tasks

~/assistant_main/                  # Runtime data (configured in .env)
├── sessions/
│   ├── main.jsonl                # Active session
│   └── archived/                 # Archived sessions
├── images/                       # Stored images
├── memory.md                     # Extracted memories
└── yesterday.md                  # Recent context (rotated)

~/.pi/agent/extensions/
└── gateway-bridge.ts             # Pi TUI bridge extension
```

## Configuration

### Gateway (.env)
```env
# Required for Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...

# Paths
PI_SESSION_PATH=~/assistant_main/sessions/main.jsonl
PI_CWD=~/assistant_main

# Intervals (ms)
MEMORY_SCAN_INTERVAL_MS=600000    # 10 min
HEARTBEAT_INTERVAL_MS=900000      # 15 min

# Models
MEMORY_MODEL=glm-4.7              # Cheaper for memory extraction
```

### Pi Extension (gateway-bridge)
Auto-detects Gateway at `ws://localhost:3456/pi-client`. No configuration needed.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Session ownership** | Gateway owns Pi RPC | Simpler than handoff model, no lock files |
| **Multi-client** | BroadcastManager pattern | All clients see same state simultaneously |
| **Pi TUI support** | Bridge extension | TUI renders natively, Gateway owns logic |
| **Image storage** | File-based with path refs | Keeps session files small, WS payloads fast |
| **Memory extraction** | Background LLM process | Non-blocking, runs on interval |
| **Heartbeats** | Prompt injection | Agent gets full context to make decisions |

## Deprecated Patterns

The following were removed/deprecated:

- **TUI handoff** (`/takeover`, lock files, session competition) - Removed in favor of bridge mode
- **TUI detection via pgrep** - No longer needed
- **Session-watcher.ts** - Removed, gateway owns session continuously

## Related Documentation

- `README.md` - Project overview, quick start
- `AGENTS.md` - Agent operational guidance
- `docs/ROADMAP.md` - Feature roadmap and specs
- `WORKLOG.md` - Daily changelog
- `ISSUES.md` - Bug tracking

## External References

- **Pi RPC docs:** `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- **Pi session docs:** `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- **Pi extensions:** `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- **grammY:** https://grammy.dev/
