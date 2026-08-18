# Personal Assistant

Personal AI assistant system with a gateway-owned Pi RPC session and multiple clients:

- Telegram bot
- macOS native app
- Web UI
- Custom TUI (Rust)
- GTK desktop client (Python/GTK3)

The gateway is the source of truth. It owns the Pi RPC process, session lifecycle, multi-client sync, background services, and local API/file serving.

## Current Architecture

```text
Telegram + macOS app + Web UI + TUI + GTK
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

The gateway keeps one shared Pi session for all clients. Prompts sent during an active run can be queued as `steer` (before the next model call) or `followUp` (after the run would otherwise finish), with queue updates broadcast to every client. The gateway also owns SQLite memory, scheduled tasks, session archival, and streaming/reliability safeguards.

## Repository Structure

```text
assistant/
├── gateway/
│   ├── bin/personalos.mjs        # CLI entrypoint (`npm link` → `personalos`)
│   ├── src/
│   │   ├── index.ts              # Gateway bootstrap
│   │   ├── cli/                  # Managed start/stop/status/logs CLI
│   │   ├── websocket-server.ts   # Standard WS server
│   │   ├── broadcast.ts          # Multi-client event distribution and queues
│   │   ├── pi-rpc.ts              # Pi RPC wrapper
│   │   ├── api-server.ts         # Local HTTP API + file serving
│   │   ├── session-manager.ts    # /new and compaction archival
│   │   ├── memory-store.ts       # SQLite memory store
│   │   ├── memory-embeddings.ts  # Ollama-backed memory embeddings
│   │   ├── daily-context.ts      # Rolling context and daily extraction
│   │   ├── task-scheduler.ts     # node-cron task scheduler
│   │   ├── tool-call-cache.ts    # Live tool labels for history enrichment
│   │   ├── heartbeat.ts          # Proactive heartbeat runner
│   │   ├── telegram.ts           # Telegram bot
│   │   └── handlers/             # WS message handlers + commands
│   └── package.json
├── clients/
│   ├── gtk/                     # Python/GTK3 desktop client
│   ├── macos/ChatAssistant/     # SwiftUI macOS client
│   ├── web_ui/                  # React/Vite browser client
│   └── tui/                     # Rust TUI client
└── docs/
    └── ARCHITECTURE.md
```

Project planning and issue-tracking documents are maintained privately outside this
repository. `WORKLOG_OLD.md` is retained there as read-only legacy history.

## Runtime Paths

Typical runtime data lives under `~/personal_assistant`:

- `sessions/main.jsonl` - active Pi session
- `sessions/archived/` - archived sessions
- `images/` - saved image attachments
- `logs/gateway.log` - gateway log file
- `run/personalos.pid` - managed process state
- `memory/memory.sqlite` - canonical durable memory
- `memory/briefing.md` and `memory/today.md` - startup and rolling context
- `memory/daily/` - daily context archives
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

### GTK client (Linux)

```bash
cd clients/gtk
./agent-gui.py
```

## Network Endpoints

- `ws://127.0.0.1:3456/` - standard clients
- `http://127.0.0.1:3457/files/<absolute-path>` - local image/file serving
- `http://127.0.0.1:3457/status` - gateway status JSON
- `http://127.0.0.1:3457/session` - current session information
- `http://127.0.0.1:3457/session/new` - archive the current session and start fresh (POST)
- `http://127.0.0.1:3457/api/tasks` - scheduled task API

## Supported Client Messages

Examples on the standard WebSocket endpoint:

```json
{ "type": "prompt", "message": "hello", "streamingBehavior": "steer" }
{ "type": "prompt_with_images", "message": "describe this", "images": [...], "streamingBehavior": "followUp" }
{ "type": "get_history", "limit": 50 }
{ "type": "get_models" }
{ "type": "switch_model", "provider": "openai", "modelId": "gpt-5.4" }
{ "type": "command", "command": "new" }
{ "type": "abort" }
```

`streamingBehavior` is optional and matters when Pi is already running: `steer` continues before the next model call, while `followUp` waits until the current run settles.

## Configuration

Primary config is `gateway/.env`.

Key variables:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
PI_SESSION_PATH=~/personal_assistant/sessions/main.jsonl
PI_CWD=~/personal_assistant
PI_PROVIDER=...
PI_MODEL=...
PI_THINKING_LEVEL=off
PI_EXCLUDE_TOOLS=question
PROMPT_INACTIVITY_TIMEOUT_MS=300000
FILE_SERVER_PORT=3457
IMAGE_DIR=~/personal_assistant/images
LOG_FILE=~/personal_assistant/logs/gateway.log
MEMORY_DB_PATH=~/personal_assistant/memory/memory.sqlite
TASK_SCHEDULER_ENABLED=true
TASK_DB_PATH=~/personal_assistant/tasks/tasks.sqlite
TASK_DEFAULT_TIMEZONE=Australia/Melbourne
TASK_MISSED_RUN_GRACE_MS=0
ABORT_GRACE_MS=2000
CLIENT_SEND_TIMEOUT_MS=8000
BROADCAST_EVENT_TIMEOUT_MS=30000
HEARTBEAT_INTERVAL_MS=900000
```

Scheduled tasks are persisted in SQLite and executed by the gateway's node-cron scheduler; the Web UI manages them through the local API. Memory tools call the gateway's SQLite store for search, write, update, and archive operations, while `daily-context.ts` maintains rolling context and daily extraction. `/session/new` archives the current Pi transcript before starting a fresh one. Pi's startup provider/model are configurable, Telegram renders tool and final messages richly, and tool labels are cached in-process so history can retain useful command summaries even when Pi's session file omits tool arguments.

## Verification

```bash
cd gateway && npx tsc --noEmit
cd clients/web_ui && npm run build
cd clients/macos/ChatAssistant && swift build
```

## Notes

- The gateway binds to localhost only.
- Telegram is optional at runtime, but the gateway currently expects Telegram config to be present.
- The custom TUI and GTK client connect as first-class standard clients.
- `memory.md` is legacy import data; new memory writes go through the gateway memory API/tools.
- The local API allows cross-origin calls from the Vite/static Web UI.
- `docs/ARCHITECTURE.md` is the detailed system reference.
