import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Load .env before reading any env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
dotenvConfig({ path: join(__dirname, "..", ".env"), quiet: true });

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID
      ? parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10)
      : null,
    useMessageDraftStreaming: process.env.TELEGRAM_USE_MESSAGE_DRAFT_STREAMING === "true",
  },
  pi: {
    sessionPath:
      process.env.PI_SESSION_PATH ??
      join(homedir(), ".pi", "agent", "sessions", "main.jsonl"),
    cwd: process.env.PI_CWD ?? homedir(),
    thinkingLevel: process.env.PI_THINKING_LEVEL ?? "off",
  },
  images: {
    dir: process.env.IMAGE_DIR
      ?? join(process.env.PI_CWD ?? homedir(), "images"),
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
      ?? join(process.env.PI_CWD ?? homedir(), "tasks", "tasks.sqlite"),
    timezone: process.env.TASK_DEFAULT_TIMEZONE ?? "Australia/Melbourne",
    missedRunGraceMs: process.env.TASK_MISSED_RUN_GRACE_MS
      ? parseInt(process.env.TASK_MISSED_RUN_GRACE_MS, 10)
      : 0,
  },
  runtime: {
    runDir: process.env.RUNTIME_DIR
      ?? join(process.env.PI_CWD ?? homedir(), "run"),
    logsDir: process.env.LOG_DIR
      ?? join(process.env.PI_CWD ?? homedir(), "logs"),
    pidFile: process.env.PID_FILE
      ?? join(process.env.PI_CWD ?? homedir(), "run", "personalos.pid"),
    logFile: process.env.LOG_FILE
      ?? join(process.env.PI_CWD ?? homedir(), "logs", "gateway.log"),
  },
  broadcast: {
    thinkingEnabled: process.env.BROADCAST_THINKING_ENABLED
      ? process.env.BROADCAST_THINKING_ENABLED === "true"
      : true,
  },
  heartbeat: {
    intervalMs: process.env.HEARTBEAT_INTERVAL_MS
      ? parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10)
      : 15 * 60 * 1000, // 15 minutes default
  },
  tui: {
    lockPath: process.env.TUI_LOCK_PATH
      ?? join(process.env.PI_CWD ?? homedir(), ".tui-session.lock"),
  },
  memory: {
    model: process.env.MEMORY_MODEL ?? "glm-4.7",
    provider: process.env.MEMORY_PROVIDER ?? "zai",
    sessionDir: process.env.MEMORY_SESSION_DIR ?? join(projectRoot, "sessions"),
    dbPath: process.env.MEMORY_DB_PATH
      ?? join(process.env.PI_CWD ?? homedir(), "memory", "memory.sqlite"),
    briefingPath: process.env.MEMORY_BRIEFING_PATH
      ?? join(process.env.PI_CWD ?? homedir(), "memory", "briefing.md"),
    briefingMaxItems: process.env.MEMORY_BRIEFING_MAX_ITEMS
      ? parseInt(process.env.MEMORY_BRIEFING_MAX_ITEMS, 10)
      : 40,
    embeddingHost: process.env.MEMORY_EMBEDDING_HOST
      ?? "http://127.0.0.1:11434",
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL ?? "qllama/bge-small-en-v1.5",
    toolsExtensionPath: process.env.MEMORY_TOOLS_EXTENSION_PATH
      ?? join(projectRoot, "gateway", "pi-extensions", "memory-tools.ts"),
    dailyContextEnabled: process.env.DAILY_CONTEXT_ENABLED
      ? process.env.DAILY_CONTEXT_ENABLED === "true"
      : true,
    todayPath: process.env.DAILY_CONTEXT_TODAY_PATH
      ?? join(process.env.PI_CWD ?? homedir(), "memory", "today.md"),
    dailyArchiveDir: process.env.DAILY_CONTEXT_ARCHIVE_DIR
      ?? join(process.env.PI_CWD ?? homedir(), "memory", "daily"),
    dailyContextStatePath: process.env.DAILY_CONTEXT_STATE_PATH
      ?? join(process.env.PI_CWD ?? homedir(), "memory", ".daily-context-state.json"),
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
  if (!Number.isInteger(config.apiServer.port) || config.apiServer.port <= 0) {
    throw new Error("FILE_SERVER_PORT must be a positive integer");
  }
  if (!Number.isInteger(config.webSocket.port) || config.webSocket.port <= 0) {
    throw new Error("GATEWAY_WS_PORT must be a positive integer");
  }
  if (!Number.isInteger(config.tasks.missedRunGraceMs) || config.tasks.missedRunGraceMs < 0) {
    throw new Error("TASK_MISSED_RUN_GRACE_MS must be a non-negative integer");
  }
}
