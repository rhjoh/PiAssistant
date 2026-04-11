# Personal Assistant

Personal AI assistant system with a gateway-owned Pi RPC session and multiple clients:

- Telegram bot
- macOS native app
- Web UI
- Pi TUI via bridge extension

The gateway is the source of truth. It owns the Pi RPC process, session lifecycle, multi-client sync, background services, and local file/status serving.

## Current Architecture

```text
Telegram + macOS app + Web UI + Pi TUI bridge
                    ↓
         Gateway (Node.js, localhost)
      - Pi RPC owner
      - WebSocket server (:3456)
      - File/status server (:3457)
      - Broadcast manager
      - Telegram adapter
      - Session manager
      - Memory watcher
      - Heartbeat
                    ↓
          Pi RPC session (main.jsonl)
```

## Repository Structure

```text
assistant/
├── gateway/
│   ├── bin/personalos.mjs        # CLI entrypoint
│   ├── src/
│   │   ├── index.ts              # Gateway bootstrap
│   │   ├── cli/                  # Managed start/stop/status/logs CLI
│   │   ├── websocket-server.ts   # Standard WS server + /pi-client routing
│   │   ├── pi-client-handler.ts  # Native Pi bridge protocol handling
│   │   ├── broadcast.ts          # Multi-client event distribution
│   │   ├── pi-rpc.ts             # Pi RPC wrapper
│   │   ├── file-server.ts        # Local image serving + /status endpoint
│   │   ├── session-manager.ts    # /new and compaction archival
│   │   ├── memory-watcher.ts     # Memory extraction background job
│   │   ├── heartbeat.ts          # Proactive heartbeat runner
│   │   ├── telegram.ts           # Telegram bot
│   │   └── handlers/             # WS message handlers + commands
│   └── package.json
├── clients/
│   ├── macos/ChatAssistant/      # SwiftUI macOS client
│   ├── web_ui/                   # React/Vite browser client
│   └── pi-extension/             # Repo copy of gateway bridge extension
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

## Quick Start

### Gateway

```bash
cd gateway
npm install
npm run dev
```

Or use the managed CLI:

```bash
cd gateway
npm install
node ./bin/personalos.mjs run
```

Background mode:

```bash
cd gateway
node ./bin/personalos.mjs start --webui
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

### Pi bridge

```bash
cp clients/pi-extension/gateway-bridge.ts ~/.pi/agent/extensions/gateway-bridge.ts
pi extensions enable gateway-bridge
pi --provider gateway-bridge
```

## Network Endpoints

- `ws://127.0.0.1:3456/` - standard clients
- `ws://127.0.0.1:3456/pi-client` - Pi bridge endpoint
- `http://127.0.0.1:3457/files/<absolute-path>` - local image/file serving
- `http://127.0.0.1:3457/status` - gateway status JSON

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
MEMORY_ENABLED=true
MEMORY_SCAN_INTERVAL_MS=600000
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
- The Pi TUI no longer owns the session directly; bridge mode is the supported path.
- `docs/ARCHITECTURE.md` is the detailed system reference.
