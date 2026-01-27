# Personal OS - Architecture Overview

## Core Concept

A personal AI assistant accessible via Telegram, powered by Pi coding agent in RPC mode, with optional TUI access via SSH.

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Telegram   │────▶│  Gateway (Node.js)  │────▶│  pi --mode rpc  │
│             │◀────│                     │◀────│                 │
└─────────────┘     └─────────────────────┘     └────────┬────────┘
                              │                          │
                              │ Session Handoff          │
                              ▼                          ▼
                    ┌─────────────────┐         ┌───────────────┐
                    │  SSH + pi TUI   │         │  main.jsonl   │
                    │  (when active)  │         │ (persistent)  │
                    └─────────────────┘         └───────────────┘
```

## Architecture Components

### 1. Gateway Service (Node.js)

**Responsibilities:**
- Receive messages from Telegram bot
- Manage Pi RPC process (spawn, communicate, restart)
- Handle session handoff when TUI access requested
- Inject heartbeat/cron messages into session
- Forward Pi responses back to Telegram

**Key behavior:**
- Single owner of Pi session at any time
- Gracefully release session for TUI access
- Auto-reclaim session when TUI exits

### 2. Pi RPC Process

**Invocation:**
```bash
pi --mode rpc --session /path/to/main.jsonl
```

**Communication:**
- JSON messages over stdin/stdout
- Gateway sends: `{"type": "prompt", "message": "..."}`
- Pi streams events back including text deltas, tool calls, completion

**Session persistence:**
- Single JSONL file per "main" conversation
- Automatic compaction when context fills
- Hook available to save raw session before compaction

### 3. Session Control (TUI vs Gateway)

**Why not both at once?**
Not file corruption - it's **state divergence**. Each Pi process loads the session into memory independently. If both write, the session tree gets unexpected branches because neither sees the other's messages.

**Solution: Single writer, force reclaim**

**Normal mode (Gateway owns session):**
- Gateway runs Pi RPC process
- Telegram messages processed normally

**TUI takes over:**
1. User SSHs to the machine, runs `pi --session <path>`
2. Gateway detects TUI process (via `pgrep` or lock file)
3. Gateway stops its Pi RPC process (graceful - TUI now owns session)

**Telegram reclaims:**
1. User sends message via Telegram while TUI active
2. Gateway replies: "TUI active. Send `/takeover` to reclaim."
3. User sends `/takeover`
4. Gateway kills TUI Pi process (`SIGTERM`)
5. Gateway restarts its Pi RPC, processes queued message

**Detection mechanism:**
- Gateway polls every ~3 seconds: `pgrep -f "pi.*--session.*main.jsonl"`
- Simple, no wrapper script needed

### 4. Proactive Messaging (Hybrid)

**Hourly Heartbeat:**
```json
{"type": "prompt", "message": "[System] Heartbeat: 2024-01-27T09:00:00Z. Check pending reminders and tasks."}
```
- Gateway injects this every hour (configurable)
- Agent can respond if there are pending items, or stay silent
- Keeps context fresh without excessive API calls

**Cron-triggered Messages:**
- Agent creates cron jobs via bash tool: `echo "remind:meeting" | at 2pm`
- Cron writes to `/data/pending-messages.txt`
- Heartbeat checks this file and includes pending items
- Alternative: Cron directly triggers gateway endpoint

### 5. Memory System

**Session Log Extraction:**
- Pi's `session_before_compact` hook saves raw session before compaction
- Alternatively: Worker periodically parses session JSONL files
- LLM extracts "memory artifacts" (facts, preferences, decisions, todos)
- Store in vector DB for RAG during future conversations

**Memory injection:**
- Gateway queries vector DB before each prompt
- Relevant memories prepended as context
- Or: Custom Pi extension that auto-injects relevant context

## Data Flow

### Message Flow (Telegram → Pi → Telegram)
```
1. User sends "remind me to call mom at 3pm" via Telegram
2. Telegram bot receives message
3. Gateway receives via webhook/polling
4. Gateway sends to Pi RPC: {"type": "prompt", "message": "remind me..."}
5. Pi processes, calls bash tool to create cron job
6. Pi responds: "I'll remind you at 3pm"
7. Gateway receives response events
8. Gateway sends response to Telegram
9. At 3pm: cron writes to pending-messages
10. Next heartbeat: Gateway includes "Reminder: call mom"
11. Pi responds, gateway forwards to Telegram
```

### TUI Session Control Flow
```
TUI Takes Over:
1. User SSHs to the machine
2. User runs: pi --session ~/.pi/agent/sessions/main.jsonl
3. Gateway detects TUI process, stops its Pi RPC
4. User interacts directly with Pi TUI

Telegram Reclaims:
1. User sends message via Telegram
2. Gateway detects TUI active, replies: "TUI active. /takeover to reclaim"
3. User sends /takeover
4. Gateway kills TUI Pi process (SIGTERM)
5. Gateway restarts Pi RPC, processes message
6. User sees response in Telegram

Natural Exit:
1. User exits TUI (Ctrl+D or /exit)
2. Gateway detects TUI gone
3. Gateway restarts Pi RPC automatically
```

## File Structure

```
~/personal-os/
├── gateway/
│   ├── src/
│   │   ├── index.ts          # Entry point
│   │   ├── telegram.ts       # Telegram bot (grammY)
│   │   ├── pi-rpc.ts         # Pi RPC client wrapper
│   │   ├── handoff.ts        # Session handoff logic
│   │   └── heartbeat.ts      # Heartbeat scheduler
│   ├── package.json
│   └── tsconfig.json
├── worker/                   # Optional: async memory extraction
│   ├── src/
│   │   ├── memory-extractor.ts
│   │   └── scheduler.ts
│   └── package.json
├── shared/
│   ├── config.ts
│   └── types.ts
├── data/
│   ├── pending-messages.txt  # Cron writes here
│   └── memory/               # Extracted artifacts
└── .env                      # TELEGRAM_BOT_TOKEN, etc.
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Pi interaction** | RPC mode | Headless, JSON protocol, existing session support |
| **Session file** | Single "main" session | Continuity, simpler than multi-session routing |
| **TUI access** | Force reclaim model | TUI takes over, `/takeover` reclaims. Simple, explicit control. |
| **Proactive messaging** | Hybrid (heartbeat + cron) | Balance between responsiveness and API cost |
| **Memory extraction** | Post-hoc parsing | Don't block conversation, extract async |
| **Telegram library** | grammY | Modern, TypeScript-native, good DX |

## Decisions Made

| Question | Decision |
|----------|----------|
| TUI access model | Force reclaim - TUI takes over, `/takeover` reclaims for Telegram |
| Proactive messaging | Hybrid - hourly heartbeat + cron for specific reminders |
| TUI reclaim method | Kill TUI process (SIGTERM) |
| Telegram during TUI | Reject with reply, offer `/takeover` |
| TUI detection | `pgrep` polling (~3s interval) |


## References

- **Pi RPC docs**: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- **Pi session docs**: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- **Pi hooks docs**: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- **grammY**: https://grammy.dev/
