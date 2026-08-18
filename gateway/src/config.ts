import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Load .env before reading any env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
dotenvConfig({ path: join(__dirname, "..", ".env"), quiet: true });
const defaultPiCwd = process.env.PI_CWD ?? join(homedir(), "personal_assistant");

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID
      ? parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10)
      : null,
    useMessageDraftStreaming: process.env.TELEGRAM_USE_MESSAGE_DRAFT_STREAMING === "true",
    useRichMessages: process.env.TELEGRAM_USE_RICH_MESSAGES !== "false", // default true
  },
  pi: {
    sessionPath:
      process.env.PI_SESSION_PATH ??
      join(defaultPiCwd, "sessions", "main.jsonl"),
    cwd: defaultPiCwd,
    provider: process.env.PI_PROVIDER?.trim() || undefined,
    model: process.env.PI_MODEL?.trim() || undefined,
    thinkingLevel: process.env.PI_THINKING_LEVEL ?? "off",
    // A prompt that emits no events for this long is considered hung and is
    // cleaned up so the gateway doesn't stay stuck. Events (text deltas, tool
    // updates) reset the timer, so this only fires during complete silence.
    promptInactivityTimeoutMs: process.env.PROMPT_INACTIVITY_TIMEOUT_MS
      ? parseInt(process.env.PROMPT_INACTIVITY_TIMEOUT_MS, 10)
      : 5 * 60 * 1000, // 5 minutes
    // Tools to disable in the Pi RPC session (passed as --exclude-tools).
    // Default excludes the interactive `question` tool — no client UI to answer it.
    excludeTools: (
      process.env.PI_EXCLUDE_TOOLS ?? "question"
    )
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  },
  images: {
    dir: process.env.IMAGE_DIR
      ?? join(defaultPiCwd, "images"),
  },
  webSocket: {
    host: process.env.GATEWAY_WS_HOST ?? "127.0.0.1",
    port: process.env.GATEWAY_WS_PORT
      ? parseInt(process.env.GATEWAY_WS_PORT, 10)
      : 3456,
  },
  apiServer: {
    host: process.env.FILE_SERVER_HOST ?? "127.0.0.1",
    port: process.env.FILE_SERVER_PORT
      ? parseInt(process.env.FILE_SERVER_PORT, 10)
      : 3457,
  },
  tasks: {
    enabled: process.env.TASK_SCHEDULER_ENABLED
      ? process.env.TASK_SCHEDULER_ENABLED === "true"
      : true,
    dbPath: process.env.TASK_DB_PATH
      ?? join(defaultPiCwd, "tasks", "tasks.sqlite"),
    timezone: process.env.TASK_DEFAULT_TIMEZONE ?? "Australia/Melbourne",
    missedRunGraceMs: process.env.TASK_MISSED_RUN_GRACE_MS
      ? parseInt(process.env.TASK_MISSED_RUN_GRACE_MS, 10)
      : 0,
  },
  runtime: {
    runDir: process.env.RUNTIME_DIR
      ?? join(defaultPiCwd, "run"),
    logsDir: process.env.LOG_DIR
      ?? join(defaultPiCwd, "logs"),
    pidFile: process.env.PID_FILE
      ?? join(defaultPiCwd, "run", "personalos.pid"),
    logFile: process.env.LOG_FILE
      ?? join(defaultPiCwd, "logs", "gateway.log"),
  },
  broadcast: {
    thinkingEnabled: process.env.BROADCAST_THINKING_ENABLED
      ? process.env.BROADCAST_THINKING_ENABLED === "true"
      : true,
    // How long abort() waits for the in-flight prompt to settle (agent_end)
    // before force-clearing the gateway state. Normal aborts settle in well
    // under a second (stream abort <1s, bash SIGKILL ~instantly); the wait only
    // avoids an unnecessary Pi RPC restart on those. A second abort press
    // skips the wait and force-clears immediately.
    abortGraceMs: process.env.ABORT_GRACE_MS
      ? parseInt(process.env.ABORT_GRACE_MS, 10)
      : 2000,
    // Hard cap on how long a single client send may block the event pipeline.
    // Prevents a hung client (e.g. Telegram Bot API) from stalling broadcasts.
    clientSendTimeoutMs: process.env.CLIENT_SEND_TIMEOUT_MS
      ? parseInt(process.env.CLIENT_SEND_TIMEOUT_MS, 10)
      : 8000,
    // Hard cap on how long a single Pi event handler may run. Backstop so a
    // stalled broadcast can never permanently wedge the event queue.
    eventHandlerTimeoutMs: process.env.BROADCAST_EVENT_TIMEOUT_MS
      ? parseInt(process.env.BROADCAST_EVENT_TIMEOUT_MS, 10)
      : 30000,
  },
  heartbeat: {
    intervalMs: process.env.HEARTBEAT_INTERVAL_MS
      ? parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10)
      : 15 * 60 * 1000, // 15 minutes default
  },
  tui: {
    lockPath: process.env.TUI_LOCK_PATH
      ?? join(defaultPiCwd, ".tui-session.lock"),
  },
  memory: {
    model: process.env.MEMORY_MODEL ?? "glm-4.7",
    provider: process.env.MEMORY_PROVIDER ?? "zai",
    sessionDir: process.env.MEMORY_SESSION_DIR ?? join(defaultPiCwd, "sessions"),
    dbPath: process.env.MEMORY_DB_PATH
      ?? join(defaultPiCwd, "memory", "memory.sqlite"),
    briefingPath: process.env.MEMORY_BRIEFING_PATH
      ?? join(defaultPiCwd, "memory", "briefing.md"),
    userProfilePath: process.env.MEMORY_USER_PROFILE_PATH
      ?? join(defaultPiCwd, "memory", "user.md"),
    briefingMaxItems: process.env.MEMORY_BRIEFING_MAX_ITEMS
      ? parseInt(process.env.MEMORY_BRIEFING_MAX_ITEMS, 10)
      : 80,
    embeddingHost: process.env.MEMORY_EMBEDDING_HOST
      ?? "http://127.0.0.1:11434",
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL ?? "qllama/bge-small-en-v1.5",
    toolsExtensionPath: process.env.MEMORY_TOOLS_EXTENSION_PATH
      ?? join(projectRoot, "gateway", "pi-extensions", "memory-tools.ts"),
    dailyContextEnabled: process.env.DAILY_CONTEXT_ENABLED
      ? process.env.DAILY_CONTEXT_ENABLED === "true"
      : true,
    todayPath: process.env.DAILY_CONTEXT_TODAY_PATH
      ?? join(defaultPiCwd, "memory", "today.md"),
    dailyArchiveDir: process.env.DAILY_CONTEXT_ARCHIVE_DIR
      ?? join(defaultPiCwd, "memory", "daily"),
    dailyContextStatePath: process.env.DAILY_CONTEXT_STATE_PATH
      ?? join(defaultPiCwd, "memory", ".daily-context-state.json"),
    dailyContextIntervalMs: process.env.DAILY_CONTEXT_INTERVAL_MS
      ? parseInt(process.env.DAILY_CONTEXT_INTERVAL_MS, 10)
      : 2 * 60 * 60 * 1000,
    dailyExtractionHour: process.env.DAILY_MEMORY_EXTRACTION_HOUR
      ? parseInt(process.env.DAILY_MEMORY_EXTRACTION_HOUR, 10)
      : 22,
    dailyContextMaxTranscriptChars: process.env.DAILY_CONTEXT_MAX_TRANSCRIPT_CHARS
      ? parseInt(process.env.DAILY_CONTEXT_MAX_TRANSCRIPT_CHARS, 10)
      : 50000,
  },
};

export function validateConfig(): void {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  }
  // Guard against NaN from parseInt on non-numeric env vars
  for (const [name, value] of [
    ["GATEWAY_WS_PORT", config.webSocket.port],
    ["FILE_SERVER_PORT", config.apiServer.port],
    ["TASK_MISSED_RUN_GRACE_MS", config.tasks.missedRunGraceMs],
    ["HEARTBEAT_INTERVAL_MS", config.heartbeat.intervalMs],
    ["PROMPT_INACTIVITY_TIMEOUT_MS", config.pi.promptInactivityTimeoutMs],
    ["ABORT_GRACE_MS", config.broadcast.abortGraceMs],
    ["CLIENT_SEND_TIMEOUT_MS", config.broadcast.clientSendTimeoutMs],
    ["BROADCAST_EVENT_TIMEOUT_MS", config.broadcast.eventHandlerTimeoutMs],
    ["MEMORY_BRIEFING_MAX_ITEMS", config.memory.briefingMaxItems],
    ["DAILY_CONTEXT_INTERVAL_MS", config.memory.dailyContextIntervalMs],
    ["DAILY_MEMORY_EXTRACTION_HOUR", config.memory.dailyExtractionHour],
    ["DAILY_CONTEXT_MAX_TRANSCRIPT_CHARS", config.memory.dailyContextMaxTranscriptChars],
  ] as const) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${name} must be a valid number, got: ${value}`);
    }
  }
  if (!Number.isInteger(config.apiServer.port) || config.apiServer.port <= 0) {
    throw new Error("FILE_SERVER_PORT must be a positive integer");
  }
  if (!Number.isInteger(config.webSocket.port) || config.webSocket.port <= 0) {
    throw new Error("GATEWAY_WS_PORT must be a positive integer");
  }
  if (!Number.isInteger(config.tasks.missedRunGraceMs) || config.tasks.missedRunGraceMs < 0) {
    throw new Error("TASK_MISSED_RUN_GRACE_MS must be a non-negative integer");
  }
  if (config.telegram.allowedUserId !== null && (!Number.isInteger(config.telegram.allowedUserId) || config.telegram.allowedUserId <= 0)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a positive integer when set");
  }
}
