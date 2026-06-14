# Personal Assistant

Personal AI assistant system with a gateway-owned Pi RPC session and multiple clients:

- Telegram bot
- macOS native app
- Web UI
- Custom TUI (Rust)

The gateway is the source of truth. It owns the Pi RPC process, session lifecycle, multi-client sync, background services, and local API/file serving.

## Current Architecture

```text
Telegram + macOS app + Web UI + TUI
                    ↓
         Gateway (Node.js, localhost)
      - Pi RPC owner
      - WebSocket server (:3456)
      - API server (:3457)
      - Broadcast manager
      - Telegram adapter
      - Session manager
      - Memory store
      - Task scheduler
      - Heartbeat
                    ↓
          Pi RPC session (main.jsonl)
```

## Repository Structure

```text
assistant/
├── gateway/
│   ├── bin/personalos.mjs        # CLI entrypoint (`npm link` → `personalos`)
│   ├── src/
│   │   ├── index.ts              # Gateway bootstrap
│   │   ├── cli/                  # Managed start/stop/status/logs CLI
│   │   ├── websocket-server.ts   # Standard WS server
│   │   ├── broadcast.ts          # Multi-client event distribution
│   │   ├── pi-rpc.ts             # Pi RPC wrapper
│   │   ├── api-server.ts         # Local HTTP API + file serving
│   │   ├── session-manager.ts    # /new and compaction archival
│   │   ├── memory-store.ts       # SQLite memory store
│   │   ├── task-scheduler.ts     # node-cron task scheduler
│   │   ├── heartbeat.ts          # Proactive heartbeat runner
│   │   ├── telegram.ts           # Telegram bot
│   │   └── handlers/             # WS message handlers + commands
│   └── package.json
├── clients/
│   ├── macos/ChatAssistant/      # SwiftUI macOS client
│   ├── web_ui/                   # React/Vite browser client
│   └── tui/                      # Rust TUI client
└── docs/
    ├── ARCHITECTURE.md
    ├── ROADMAP.md
    └── WEBUI_MESSAGE_FLOW_ISSUES.md
```

## Runtime Paths

Typical runtime data lives under `~/assistant_main`:

- `sessions/main.jsonl` - active Pi session
- `sessions/archived/` - archived sessions
- `images/` - saved image attachments
- `logs/gateway.log` - gateway log file
- `run/personalos.pid` - managed process state
- `memory.md` - extracted long-term memory
- `tasks/tasks.sqlite` - scheduled task definitions and run history

## Quick Start

### Gateway

```bash
cd gateway
npm install
npm run dev
```

Or use the managed CLI (requires `npm link` in `gateway/` first):

```bash
cd gateway
npm link
personalos run
```

Other commands:

```bash
personalos start
personalos stop       # Stop background gateway
personalos restart    # Restart
personalos status     # Check if running
personalos logs       # View recent logs
personalos logs -f    # Tail logs
personalos webui start # Start webUI dev server
```

### macOS client

```bash
cd clients/macos/ChatAssistant
swift build
swift run
```

### Web UI

```bash
cd clients/web_ui
npm install
npm run dev
```

## Network Endpoints

- `ws://127.0.0.1:3456/` - standard clients
- `http://127.0.0.1:3457/files/<absolute-path>` - local image/file serving
- `http://127.0.0.1:3457/status` - gateway status JSON
- `http://127.0.0.1:3457/api/tasks` - scheduled task API

## Supported Client Messages

Examples on the standard WebSocket endpoint:

```json
{ "type": "prompt", "message": "hello" }
{ "type": "prompt_with_images", "message": "describe this", "images": [...] }
{ "type": "get_history", "limit": 50 }
{ "type": "get_models" }
{ "type": "switch_model", "provider": "openai", "modelId": "gpt-5.4" }
{ "type": "command", "command": "new" }
{ "type": "abort" }
```

## Configuration

Primary config is `gateway/.env`.

Key variables:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
PI_SESSION_PATH=~/assistant_main/sessions/main.jsonl
PI_CWD=~/assistant_main
PI_THINKING_LEVEL=off
FILE_SERVER_PORT=3457
IMAGE_DIR=~/assistant_main/images
LOG_FILE=~/assistant_main/logs/gateway.log
MEMORY_DB_PATH=~/assistant_main/memory/memory.sqlite
TASK_DB_PATH=~/assistant_main/tasks/tasks.sqlite
TASK_DEFAULT_TIMEZONE=Australia/Melbourne
HEARTBEAT_INTERVAL_MS=900000
```

## Verification

```bash
cd gateway && npx tsc --noEmit
cd clients/web_ui && npm run build
cd clients/macos/ChatAssistant && swift build
```

## Notes

- The gateway binds to localhost only.
- Telegram is optional at runtime, but the gateway currently expects Telegram config to be present.
- The custom TUI connects as a first-class standard client.
- `docs/ARCHITECTURE.md` is the detailed system reference.
