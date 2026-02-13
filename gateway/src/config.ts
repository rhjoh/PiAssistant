import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Load .env before reading any env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
dotenvConfig({ path: join(__dirname, "..", ".env") });

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedUserId: process.env.TELEGRAM_ALLOWED_USER_ID
      ? parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10)
      : null,
  },
  pi: {
    sessionPath:
      process.env.PI_SESSION_PATH ??
      join(homedir(), ".pi", "agent", "sessions", "main.jsonl"),
    cwd: process.env.PI_CWD ?? homedir(),
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
    enabled: process.env.MEMORY_ENABLED
      ? process.env.MEMORY_ENABLED === "true"
      : true,
    model: process.env.MEMORY_MODEL ?? "glm-4.7",
    provider: process.env.MEMORY_PROVIDER ?? "zai",
    sessionDir: process.env.MEMORY_SESSION_DIR ?? join(projectRoot, "sessions"),
    outputDir: process.env.MEMORY_OUTPUT_DIR
      ?? (process.env.PI_CWD ?? homedir()),
    statePath: process.env.MEMORY_STATE_PATH
      ?? join(process.env.PI_CWD ?? homedir(), ".memory-watcher-state.json"),
    intervalMs: process.env.MEMORY_SCAN_INTERVAL_MS
      ? parseInt(process.env.MEMORY_SCAN_INTERVAL_MS, 10)
      : 10 * 60 * 1000, // 10 minutes default
    activeWindowMs: process.env.MEMORY_ACTIVE_WINDOW_MINUTES
      ? parseInt(process.env.MEMORY_ACTIVE_WINDOW_MINUTES, 10) * 60 * 1000
      : 60 * 60 * 1000, // 60 minutes default
    memoryPromptPath: process.env.MEMORY_PROMPT_PATH
      ?? join(process.env.PI_CWD ?? homedir(), "memory-prompt.md"),
  },
};

export function validateConfig(): void {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  }
}
