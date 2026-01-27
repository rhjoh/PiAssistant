# Personal OS Gateway (Pi + Telegram)

A personal AI assistant that bridges Telegram messages to a local Pi coding agent running in RPC mode. The gateway owns a single persistent Pi session and forwards responses back to Telegram.

```
Telegram ↔ Gateway (Node.js) ↔ Pi RPC ↔ Session (JSONL)
```

## What's in this repo

- `gateway/` — Node.js/TypeScript gateway service (grammY bot + Pi RPC client)
- `docs/` — architecture notes and roadmap
- `sessions/` — session JSONL files used during development
- `working_dir/` — working context for the agent

## Current behavior

- Telegram bot receives messages and forwards them to Pi in RPC mode.
- Pi streams text deltas; the gateway aggregates and replies once complete.
- If tools run during a prompt, the final response is sent as a formatted HTML code block.
- `/takeover` exists but is not yet implemented (planned for TUI handoff).

Planned work and known issues live in `docs/feature_roadmap.md`.

## Setup

1. Install gateway dependencies:

   ```bash
   cd gateway
   npm install
   ```

2. Create `gateway/.env`:

   ```env
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_ALLOWED_USER_ID=123456789

   # Optional overrides
   PI_SESSION_PATH=/path/to/main.jsonl
   PI_CWD=/path/for/pi/working/dir
   ```

3. Run the gateway:
   ```bash
   cd gateway
   npm run dev
   ```

## Configuration notes

- `TELEGRAM_ALLOWED_USER_ID` is used to whitelist a single user.
- Default Pi session path is `~/.pi/agent/sessions/main.jsonl` unless overridden.
- Pi must be available on PATH as `pi`.
- If you want to keep sessions and a working directory inside this repo, create them manually (e.g., `mkdir -p sessions working_dir`) and point `PI_SESSION_PATH` / `PI_CWD` to those paths in `gateway/.env`.

## Key files

- `gateway/src/index.ts` — process startup, wiring, and shutdown
- `gateway/src/telegram.ts` — Telegram bot handlers and formatting
- `gateway/src/pi-rpc.ts` — Pi RPC process wrapper and event handling
- `gateway/src/config.ts` — environment configuration
- `docs/ARCHITECTURE.md` — system design and future plans
- `docs/feature_roadmap.md` — current priorities, bugs, and roadmap

## Development workflow

There is no automated test suite yet. The current manual loop is:

1. `cd gateway && npm run dev`
2. Send messages in Telegram
3. Watch gateway logs for errors

## Notes

This is a single-user personal project. Simplicity over enterprise patterns.
