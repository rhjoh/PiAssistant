# PiAssistant Architecture

**Last Updated:** 2026-08-25

## Overview

PiAssistant is a local multi-client assistant platform. The gateway owns a persistent Pi RPC session and exposes that session to multiple clients simultaneously.

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

## Components

### 1. Gateway

Location: `gateway/src/`

The gateway is the runtime hub. It starts Pi, owns the session, forwards prompts, broadcasts streaming events, and runs auxiliary services.

Key modules:

| File | Responsibility |
|------|----------------|
| `index.ts` | Bootstrap and service lifecycle |
| `config.ts` | Env-driven config loading and validation |
| `pi-rpc.ts` | Pi RPC process wrapper and event handling |
| `websocket-server.ts` | Standard WebSocket server |
| `broadcast.ts` | Multi-client distribution and prompt coordination |
| `handlers/messages.ts` | Standard WS message routing |
| `handlers/commands.ts` | Command registry for WS clients (`/task` etc.) |
| `commands.ts` | Telegram command handlers (`/status`, `/model`, `/session`, `/new`) |
| `telegram.ts` | Telegram bot integration |
| `telegram-client.ts` | Telegram adapter for broadcast layer |
| `session-manager.ts` | `/new`, archive flow, compaction handling |
| `logging.ts` | Timestamped console output |
| `status-types.ts` | Shared status snapshot types |
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
pi --mode rpc --session ~/personal_assistant/sessions/main.jsonl
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
- TUI
- GTK desktop client

Client → gateway messages:

```json
{ "type": "prompt", "message": "hello", "id": "optional-turn-id", "streamingBehavior": "steer" }
{ "type": "prompt_with_images", "message": "describe this", "images": [{ "data": "<base64>", "mimeType": "image/png" }], "streamingBehavior": "followUp" }
{ "type": "abort" }
{ "type": "get_state" }
{ "type": "get_history", "limit": 50 }
{ "type": "get_models" }
{ "type": "switch_model", "provider": "openai", "modelId": "gpt-5.4" }
{ "type": "get_thinking_levels" }
{ "type": "set_thinking_level", "level": "high" }
{ "type": "command", "command": "new", "args": [] }
{ "type": "ping", "timestamp": 0 }
{ "type": "extension_ui_response", "id": "uuid-1", "value": "Allow" }
```

Gateway → client messages:

```json
{ "type": "connection", "data": { "connected": true, "model": { "provider": "...", "id": "...", "name": "...", "reasoning": true, "thinkingLevels": ["off", "low", "high"] }, "contextWindow": 200000, "contextTokens": 0, "thinkingLevel": "high", "availableThinkingLevels": ["off", "low", "high"], "isProcessing": false, "sessionId": "...", "sessionUsage": { "...": 0 }, "working": null, "pendingExtensionUi": null } }
{ "type": "user_message", "data": { "content": "...", "source": "telegram" } }
{ "type": "text_delta", "data": { "content": "..." } }
{ "type": "thinking_delta", "data": { "thinkingId": "thinking-1", "content": "...", "seq": 1 } }
{ "type": "thinking_done", "data": { "thinkingId": "thinking-1", "content": "...", "seq": 1 } }
{ "type": "tool_start", "data": { "toolCallId": "...", "toolName": "bash", "args": { ... }, "label": "$ ls" } }
{ "type": "tool_output", "data": { "toolCallId": "...", "output": "...", "truncated": false } }
{ "type": "tool_end", "data": { "toolCallId": "...", "toolName": "bash" } }
{ "type": "image", "data": { "source": "/abs/path/to/image.png", "alt": "..." } }
{ "type": "usage", "data": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0, "cost": 0, "contextTokens": 0 } }
{ "type": "prompt_accepted", "data": { "id": "...", "content": "...", "originClientId": "..." } }
{ "type": "prompt_queued", "data": { "id": "...", "content": "...", "behavior": "steer", "originClientId": "..." } }
{ "type": "queue_update", "data": { "steering": [], "followUp": [] } }
{ "type": "abort_complete", "data": { "forced": false, "restarted": false, "message": "Prompt aborted. Ready for a new message." } }
{ "type": "response_segment_done", "data": { "finalText": "...", "turnId": "..." } }
{ "type": "done", "data": { "finalText": "...", "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0, "cost": 0, "cumulative": { "...": 0 }, "contextTokens": 0 } } }
{ "type": "state", "data": { "isProcessing": false, "model": { "provider": "...", "id": "...", "name": "...", "reasoning": true, "thinkingLevels": ["off", "low", "high"] }, "contextWindow": 200000, "contextTokens": 0, "thinkingLevel": "high", "availableThinkingLevels": ["off", "low", "high"], "sessionUsage": { "...": 0 }, "sessionId": "...", "isCompacting": false, "working": { "kind": "compaction", "message": "Compacting context…" }, "pendingExtensionUi": null } }
{ "type": "extension_ui_request", "data": { "id": "uuid-1", "method": "select", "title": "Allow?", "options": ["Yes", "No"] } }
{ "type": "extension_ui_resolved", "data": { "id": "uuid-1", "cancelled": false } }
{ "type": "notify", "data": { "message": "...", "notifyType": "warning" } }
{ "type": "extension_error", "data": { "message": "...", "extensionPath": "..." } }
{ "type": "history", "data": { "messages": [...] } }
{ "type": "models", "data": { "models": [...], "current": { "provider": "...", "id": "...", "name": "..." } } }
{ "type": "model_switched", "data": { "success": true, "model": { "provider": "...", "id": "...", "name": "..." }, "error": "..." } }
{ "type": "thinking_levels", "data": { "levels": ["off", "low", "high"], "current": "high", "model": { "...": "..." } } }
{ "type": "thinking_level_changed", "data": { "success": true, "requestedLevel": "high", "level": "high", "availableLevels": ["off", "low", "high"] } }
{ "type": "proactive", "data": { "message": "..." } }
{ "type": "error", "data": { "message": "..." } }
{ "type": "pong", "data": { "timestamp": 0 } }
```

Notes:

- Standard clients receive session history on connect.
- Images are served by path, not embedded base64, where possible.
- Task-originated turns attach task metadata (`origin: "task"`, `taskId`, `taskRunId`, `taskName`) to stream events; all user-facing stream events carry `turnId` and `originClientId`.
- `prompt_accepted` acknowledges a root prompt to its submitting client. A prompt accepted during an active user run uses Pi-native steering or follow-up behavior; `prompt_queued` acknowledges that acceptance, `queue_update` reports pending work, `response_segment_done` closes an intermediate logical response, and final `done` is emitted only when Pi reports `agent_settled`.
- Every successful abort ends with `state.isProcessing=false` followed by `abort_complete`. Its `forced` and `restarted` flags distinguish a cooperative Pi abort from a stuck-tool force-clear/process restart.
- Session reset (`/new`) broadcasts a full authoritative `state` after Pi switches to the fresh session, so clients immediately replace the previous model, thinking level, context window, and token count. The `sessionId` field changes; clients should clear their local transcript when it does.
- `state` is the live snapshot of the Pi/gateway session. The gateway pushes it on connect (`connection` includes the same fields), prompt start/end, abort, model/thinking changes, compaction, auto-retry, and extension UI wait/resolve. Clients should treat `get_state` as a refresh, not the primary way to learn what is happening.
- Pi extension UI (`extension_ui_request` / `extension_ui_response`) is the RPC translation of `ctx.ui.select/confirm/input/editor`. Dialogs block Pi until a client answers; the first valid response wins and `extension_ui_resolved` dismisses the prompt on every client. Abort cancels a pending dialog. Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) do not wait.
- `working` on `state` is the live activity line: waiting for an extension UI answer, compacting, retrying, or an extension status string. `error`, `notify` (`error`/`warning`), and `extension_error` are user-visible failures.
- Thinking blocks are implicit: there is no `thinking_start` message. The first `thinking_delta` for a block opens it (each block gets an incrementing `thinkingId` and `seq`), and `thinking_done` closes it with the finalized content. The gateway also flushes an open block silently when Pi transitions straight from thinking into a tool call.
- `tool_output` is emitted once with an empty string immediately after `tool_start` so clients can render a live result block, then on each update and finally with the complete output (with `truncated` flag when oversized output is cut).
- Internal heartbeat/no-op traffic is filtered aggressively but is still an active area of cleanup.

### 4. Telegram

Telegram is treated as another client via the broadcast layer.

Current commands:

- `/status`
- `/model`
- `/model list`
- `/model <n>`
- `/session`
- `/new`
- `/task` (scheduled task management)

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

The macOS client is still a major client surface, but its Swift files are large and modularization remains backlog work. Unknown WebSocket types (extension UI, notify) are logged and ignored.

### 7b. GTK Client

Location: `clients/gtk/`

Implemented capabilities:

- GTK3 desktop client with reconnecting WebSocket transport
- interactive Pi extension UI (`select` / `confirm` / `input` / `editor`) for question, permission-gate, plan-mode, and goal dialogs
- red error text for gateway errors, extension errors, and warning notifications
- working banner plus status-line activity for compaction, retry, and waiting-for-input
- treats pushed `state` (including `sessionId`, `contextTokens`, `isProcessing`, `working`) as authoritative

Images are not rendered yet.

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

Runtime paths typically point to `~/personal_assistant/sessions/main.jsonl` and `~/personal_assistant/sessions/archived/`.

### 10. Memory System

Current memory is gateway-owned and SQLite-backed. Pi accesses it through a Pi extension that calls the gateway API server.

Active modules:

| File | Responsibility |
|------|----------------|
| `gateway/src/memory-store.ts` | SQLite schema, writes, FTS search, vector search, briefing generation |
| `gateway/src/memory-embeddings.ts` | Ollama embedding client |
| `gateway/src/daily-context.ts` | Periodic `today.md` rewrite and daily durable extraction |
| `gateway/pi-extensions/memory-tools.ts` | Pi `memory_search`, `memory_write`, `memory_update`, `memory_archive` tools |
| `gateway/src/api-server.ts` | HTTP memory endpoints |

Runtime paths:

- Canonical DB: `~/personal_assistant/memory/memory.sqlite`
- Startup briefing: `~/personal_assistant/memory/briefing.md`
- Rolling current-day context: `~/personal_assistant/memory/today.md`
- Daily context archive: `~/personal_assistant/memory/daily/YYYY-MM-DD.md`
- Legacy markdown import/source: `~/personal_assistant/memory.md`

Retrieval combines SQLite FTS with sqlite-vec embeddings. Embeddings are generated through Ollama using `MEMORY_EMBEDDING_HOST` and `MEMORY_EMBEDDING_MODEL`.

The gateway loads `gateway/pi-extensions/memory-tools.ts` into the main Pi RPC process. Those tools do not write markdown files directly; they call the API server endpoints:

```text
POST /memory/search
POST /memory/write
POST /memory/archive
GET  /memory/briefing
POST /memory/briefing
POST /memory/extract
```

The extension exposes four tools to Pi:

- `memory_search` — semantic/FTS retrieval of durable memories
- `memory_write` — create a new durable memory
- `memory_update` — update an existing memory by ID
- `memory_archive` — soft-delete (archive) memories by ID

`daily-context.ts` runs extraction separately from the main Pi RPC session with `pi -p --no-session --no-tools`. It periodically rewrites `today.md` from recent transcript deltas. Once per day, it scans the day's context and writes durable memory candidates into SQLite through `MemoryStore`.

Manual extraction can be triggered through the local API:

```bash
curl -X POST http://127.0.0.1:3457/memory/extract \
  -H 'Content-Type: application/json' \
  -d '{"forceExtraction":true}'
```

Without `forceExtraction`, the endpoint runs a normal daily context tick: it refreshes `today.md` from new transcript entries, then runs durable extraction only if the configured extraction hour has passed and today's extraction has not already run. With `forceExtraction: true`, it bypasses those time/date guards and attempts extraction for the current date. The response includes `updatedToday`, `entriesProcessed`, `extractionRan`, `memoriesSaved`, `date`, and, when applicable, `skippedReason`.

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

- Task DB: `~/personal_assistant/tasks/tasks.sqlite` by default

Execution flow:

1. A task is created through `/task` or `POST /api/tasks`.
2. `TaskScheduler` registers enabled tasks with `node-cron`.
3. When a schedule fires, `TaskRunner` creates a `task_runs` row and asks `BroadcastManager` to queue the rendered prompt.
4. The prompt waits until active user work finishes, then runs through the normal Pi RPC stream.
5. Clients receive normal stream events with task metadata (`origin`, `taskId`, `taskRunId`).

`memory.md` is not the canonical writable store. It exists as legacy input/reference material and can be imported, but new writes should go through `memory_write` or `POST /memory/write`.

#### Legacy Memory Watcher

Location: `gateway/src/memory-watcher.ts`

The old watcher scanned session history on an interval, extracted memory artifacts with an LLM, wrote markdown outputs under `~/personal_assistant`, and tracked offsets in a sidecar state file. It is preserved for reference only and is not wired into the current gateway startup path.

### 12. Heartbeat

Location: `gateway/src/heartbeat.ts`

Current behavior:

- sends internal prompts on an interval
- skipped when recent user activity falls inside the quiet window (5 min)
- queues through Pi RPC FIFO when busy (no idle gate yet — see GW-15 redesign plan)
- broadcasts only real proactive responses, not `[[NO_ACTION]]`

Heartbeat proactive messages are handled by all standard clients; Web UI filters heartbeat-style no-op messages.

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

All commands detect gateway health via the PID file (`~/personal_assistant/run/personalos.pid`) and communicate through the API server (`:3457`) for status and session operations.

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

- `~/personal_assistant/sessions/main.jsonl`
- `~/personal_assistant/sessions/archived/`
- `~/personal_assistant/images/`
- `~/personal_assistant/logs/gateway.log`
- `~/personal_assistant/run/personalos.pid`
- `~/personal_assistant/memory.md`
- `~/personal_assistant/tasks/tasks.sqlite`

## Known Documentation Boundaries

- `README.md` is for setup and orientation.
- This file is the authoritative architecture overview.
- Project planning and active issue tracking are maintained privately outside this repository; `WORKLOG_OLD.md` is read-only legacy history.
