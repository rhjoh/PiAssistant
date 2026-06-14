# PiAssistant Architecture

**Last Updated:** 2026-06-14

## Overview

PiAssistant is a local multi-client assistant platform. The gateway owns a persistent Pi RPC session and exposes that session to multiple clients simultaneously.

```text
Telegram + macOS app + Web UI + Pi TUI bridge
                    ↓
         Gateway (Node.js, localhost)
      - Pi RPC owner
      - WebSocket server (:3456)
      - API server (:3457)
      - Broadcast manager
      - Telegram adapter
      - Session manager
      - Memory store/API
      - Daily context manager
      - Task scheduler
      - Heartbeat
                    ↓
          Pi RPC session (main.jsonl)
```

## Core Principles

1. Gateway owns the Pi session continuously.
2. All clients observe the same conversation state.
3. The session file is shared state; clients are just views/controllers.
4. Broadcasted events are the integration contract for standard clients.
5. Pi bridge mode exists so the TUI can participate without taking session ownership.

## Components

### 1. Gateway

Location: `gateway/src/`

The gateway is the runtime hub. It starts Pi, owns the session, forwards prompts, broadcasts streaming events, and runs auxiliary services.

Key modules:

| File | Responsibility |
|------|----------------|
| `index.ts` | Bootstrap and service lifecycle |
| `pi-rpc.ts` | Pi RPC process wrapper and event handling |
| `websocket-server.ts` | Standard WebSocket server and `/pi-client` routing |
| `pi-client-handler.ts` | Native protocol bridge for Pi TUI |
| `broadcast.ts` | Multi-client distribution and prompt coordination |
| `handlers/messages.ts` | Standard WS message routing |
| `handlers/commands.ts` | Command handlers for WS clients |
| `telegram.ts` | Telegram bot integration |
| `telegram-client.ts` | Telegram adapter for broadcast layer |
| `session-manager.ts` | `/new`, archive flow, compaction handling |
| `memory-store.ts` | SQLite-backed durable memory store and search |
| `memory-embeddings.ts` | Ollama embedding client for vector search |
| `daily-context.ts` | Rolling today context and daily extraction |
| `task-store.ts` | SQLite scheduled task definitions and run history |
| `task-scheduler.ts` | `node-cron` timer registration and lifecycle |
| `task-runner.ts` | Scheduled/manual task prompt execution |
| `heartbeat.ts` | Periodic internal prompts |
| `api-server.ts` | Local HTTP API, status, memory/session/task endpoints, file serving |
| `gateway-status.ts` | Runtime status snapshot provider |
| `image-storage.ts` | Image persistence and history sanitization |
| `cli/index.ts` | `personalos` process manager/status/logs CLI |

Startup flow:

1. Load `.env` and validate config.
2. Ensure runtime/session directories exist.
3. Start Pi RPC.
4. Start WebSocket server on `127.0.0.1:3456`.
5. Start API server on `127.0.0.1:3457`.
6. Initialize the memory store and generated briefing.
7. Initialize task store and rehydrate enabled scheduled tasks.
8. Start heartbeat and daily context manager.
9. Start Telegram bot.

### 2. Pi RPC

Invocation pattern:

```bash
pi --mode rpc --session ~/assistant_main/sessions/main.jsonl
```

The gateway starts Pi without forcing a model via CLI flags so Pi can restore model state from the session.

Key behaviors:

- prompts and image prompts go through RPC
- model switching is done via `set_model`
- thinking level can be set via RPC
- compaction/session events are observed by the gateway
- prompt source is tracked so internal turns can be filtered from user-facing broadcasts

### 3. Standard WebSocket API

Endpoint:

- `ws://127.0.0.1:3456/`

Used by:

- macOS client
- Web UI
- future standard clients

Client → gateway messages:

```json
{ "type": "prompt", "message": "hello" }
{ "type": "prompt_with_images", "message": "describe this", "images": [...] }
{ "type": "abort" }
{ "type": "get_state" }
{ "type": "get_history", "limit": 50 }
{ "type": "get_models" }
{ "type": "switch_model", "provider": "openai", "modelId": "gpt-5.4" }
{ "type": "command", "command": "new", "args": [] }
```

Gateway → client messages:

```json
{ "type": "connection", "data": { "connected": true, "model": "...", "provider": "..." } }
{ "type": "user_message", "data": { "content": "...", "source": "telegram" } }
{ "type": "text_delta", "data": { "content": "..." } }
{ "type": "thinking_delta", "data": { "content": "..." } }
{ "type": "thinking_done", "data": { "content": "..." } }
{ "type": "tool_start", "data": { "toolCallId": "...", "toolName": "bash", "label": "$ ls" } }
{ "type": "tool_output", "data": { "toolCallId": "...", "output": "..." } }
{ "type": "tool_end", "data": { "toolCallId": "...", "toolName": "bash" } }
{ "type": "image", "data": { "source": "/abs/path/to/image.png", "alt": "..." } }
{ "type": "done", "data": { "finalText": "...", "usage": { "...": 0 } } }
{ "type": "history", "data": { "messages": [...] } }
{ "type": "models", "data": { "models": [...], "current": { "...": "..." } } }
{ "type": "model_switched", "data": { "success": true, "model": { "...": "..." } } }
{ "type": "state", "data": { "isProcessing": false, "model": "...", "provider": "..." } }
{ "type": "proactive", "data": { "message": "..." } }
{ "type": "error", "data": { "message": "..." } }
```

Notes:

- Standard clients receive session history on connect.
- Images are served by path, not embedded base64, where possible.
- Internal heartbeat/no-op traffic is filtered aggressively but is still an active area of cleanup.

### 4. Pi TUI Bridge

Endpoints and files:

- Gateway endpoint: `ws://127.0.0.1:3456/pi-client`
- Repo copy: `clients/pi-extension/gateway-bridge.ts`
- Active runtime copy: `~/.pi/agent/extensions/gateway-bridge.ts`

The bridge registers a custom provider so the Pi TUI can act as another client while the gateway still owns the underlying session.

High-level flow:

1. TUI connects to `/pi-client`.
2. User prompt is forwarded to gateway.
3. Gateway runs the real Pi RPC turn.
4. Bridge translates gateway-native events back into Pi-native stream events.
5. TUI renders using its native event model.

This area has been implemented and improved, but tool lifecycle fidelity on error/retry chains has historically been a fragile spot.

### 5. Telegram

Telegram is treated as another client via the broadcast layer.

Current commands:

- `/status`
- `/model`
- `/model list`
- `/model <n>`
- `/session`
- `/new`
- `/takeover` returns a deprecation message because gateway ownership is the active model

Telegram remains first-class for messaging, but it does not impersonate other user-originated clients.

### 6. Web UI

Location: `clients/web_ui/`

Implemented capabilities:

- React + Vite + TypeScript app
- auto-reconnecting WebSocket client
- history hydration on connect
- streaming text/thinking/tool rendering
- debug panel
- sticky auto-scroll
- theme system
- model list/switch UI
- image upload/display
- token display

The Web UI is no longer speculative or secondary documentation-wise; it is one of the main clients.

### 7. macOS Client

Location: `clients/macos/ChatAssistant/`

Implemented capabilities:

- native SwiftUI app
- streaming conversation rendering
- tool call/result views
- image drag/drop and paste
- slash command popup
- zoom support
- auto-scroll behavior
- theme toggle

The macOS client is still a major client surface, but its Swift files are large and modularization remains backlog work.

### 8. API Server

Location: `gateway/src/api-server.ts`

HTTP endpoint:

- `http://127.0.0.1:3457/files/<absolute-path>`
- `http://127.0.0.1:3457/status`
- `http://127.0.0.1:3457/memory/*`
- `http://127.0.0.1:3457/session/*`
- `http://127.0.0.1:3457/api/tasks`

Responsibilities:

- serve saved image files to browser clients
- constrain file access to allowed roots
- provide runtime status JSON for the CLI and external checks
- expose local memory, session, and scheduled task APIs

### 9. Session Management

Location: `gateway/src/session-manager.ts`

Current session behavior:

- main session lives at `PI_SESSION_PATH`
- `/new` archives current session and starts a fresh one
- auto-compaction events are observed and used for archival/rotation logic
- `clear` is broadcast to clients after session reset flows

Runtime paths typically point to `~/assistant_main/sessions/main.jsonl` and `~/assistant_main/sessions/archived/`.

### 10. Memory System

Current memory is gateway-owned and SQLite-backed. Pi accesses it through a Pi extension that calls the gateway API server.

Active modules:

| File | Responsibility |
|------|----------------|
| `gateway/src/memory-store.ts` | SQLite schema, writes, FTS search, vector search, briefing generation |
| `gateway/src/memory-embeddings.ts` | Ollama embedding client |
| `gateway/src/daily-context.ts` | Periodic `today.md` rewrite and daily durable extraction |
| `gateway/pi-extensions/memory-tools.ts` | Pi `memory_search` and `memory_write` tools |
| `gateway/src/api-server.ts` | HTTP memory endpoints |

Runtime paths:

- Canonical DB: `~/assistant_main/memory/memory.sqlite`
- Startup briefing: `~/assistant_main/memory/briefing.md`
- Rolling current-day context: `~/assistant_main/memory/today.md`
- Daily context archive: `~/assistant_main/memory/daily/YYYY-MM-DD.md`
- Legacy markdown import/source: `~/assistant_main/memory.md`

Retrieval combines SQLite FTS with sqlite-vec embeddings. Embeddings are generated through Ollama using `MEMORY_EMBEDDING_HOST` and `MEMORY_EMBEDDING_MODEL`.

The gateway loads `gateway/pi-extensions/memory-tools.ts` into the main Pi RPC process. Those tools do not write markdown files directly; they call the API server endpoints:

```text
POST /memory/search
POST /memory/write
GET  /memory/briefing
POST /memory/briefing
```

`daily-context.ts` runs extraction separately from the main Pi RPC session with `pi -p --no-session --no-tools`. It periodically rewrites `today.md` from recent transcript deltas. Once per day, it scans the day's context and writes durable memory candidates into SQLite through `MemoryStore`.

### 11. Task Scheduler

Scheduled tasks are Gateway-owned prompt templates stored in SQLite and armed with `node-cron` while the Gateway process is running.

Active modules:

| File | Responsibility |
|------|----------------|
| `gateway/src/task-store.ts` | `tasks` and `task_runs` SQLite persistence |
| `gateway/src/task-scheduler.ts` | Rehydrates enabled tasks and manages live cron handles |
| `gateway/src/task-runner.ts` | Renders prompts and records run status |
| `gateway/src/api-server.ts` | `/api/tasks` REST endpoints |
| `gateway/src/handlers/commands.ts` | `/task` command |

Runtime paths:

- Task DB: `~/assistant_main/tasks/tasks.sqlite` by default

Execution flow:

1. A task is created through `/task` or `POST /api/tasks`.
2. `TaskScheduler` registers enabled tasks with `node-cron`.
3. When a schedule fires, `TaskRunner` creates a `task_runs` row and asks `BroadcastManager` to queue the rendered prompt.
4. The prompt waits until active user work finishes, then runs through the normal Pi RPC stream.
5. Clients receive normal stream events with task metadata (`origin`, `taskId`, `taskRunId`).

`memory.md` is not the canonical writable store. It exists as legacy input/reference material and can be imported, but new writes should go through `memory_write` or `POST /memory/write`.

#### Legacy Memory Watcher

Location: `gateway/src/memory-watcher.ts`

The old watcher scanned session history on an interval, extracted memory artifacts with an LLM, wrote markdown outputs under `~/assistant_main`, and tracked offsets in a sidecar state file. It is preserved for reference only and is not wired into the current gateway startup path.

### 12. Heartbeat

Location: `gateway/src/heartbeat.ts`

Current behavior:

- sends internal prompts on an interval
- skips while user prompts are active
- skips when recent user activity falls inside the quiet window
- broadcasts only real proactive responses, not `[[NO_ACTION]]`

Heartbeat-related rendering/filtering across clients is still an active bug-prone area, especially in the Web UI.

### 13. CLI (`personalos`)

Entry points:

- `gateway/bin/personalos` (symlinked into project root)
- `gateway/src/cli/index.ts`

Commands:

| Command | Description |
|---------|-------------|
| `personalos start` | Start the gateway as a background daemon |
| `personalos start --webui` | Start gateway + Web UI dev server |
| `personalos stop` | Stop the running gateway |
| `personalos restart` | Stop then start |
| `personalos status` | Runtime status snapshot (health, PID, uptime, model, session) |
| `personalos session` | Session path, archive dir, compaction count, context window stats, cumulative tokens/cost |
| `personalos session new` | Archive current session and start a fresh one (POST /session/new) |
| `personalos logs` | Stream or dump gateway log output (`-f` to tail) |

All commands detect gateway health via the PID file (`~/assistant_main/run/personalos.pid`) and communicate through the API server (`:3457`) for status and session operations.

## Data Flows

### User Prompt Flow

```text
Client prompt
  ↓
Gateway validates and records source
  ↓
BroadcastManager sends user echo to other clients
  ↓
Pi RPC streams events
  ↓
BroadcastManager serializes and forwards events
  ↓
Clients render streaming turn
```

### History Flow

```text
Client connects
  ↓
Gateway reads session JSONL
  ↓
Image/base64 content is sanitized to file-backed references
  ↓
Gateway sends history payload
  ↓
Client hydrates local message state
```

### Image Flow

```text
Client uploads image
  ↓
Gateway validates and saves image to disk
  ↓
Gateway forwards base64 image data to Pi RPC
  ↓
Session/history references are stored and later served by the API server
  ↓
Browser clients load image via :3457/files/...
```

### Heartbeat Flow

```text
Heartbeat timer fires
  ↓
Gateway checks busy state and quiet window
  ↓
Internal Pi prompt runs
  ↓
No-op markers are dropped
  ↓
Real proactive response is broadcast
```

## Runtime Paths

Common runtime paths:

- `~/assistant_main/sessions/main.jsonl`
- `~/assistant_main/sessions/archived/`
- `~/assistant_main/images/`
- `~/assistant_main/logs/gateway.log`
- `~/assistant_main/run/personalos.pid`
- `~/assistant_main/memory.md`
- `~/assistant_main/tasks/tasks.sqlite`

## Known Documentation Boundaries

- `README.md` is for setup and orientation.
- This file is the authoritative architecture overview.
- `docs/ROADMAP.md` should be read as current direction and known gaps, not a guaranteed record of every implemented detail.
