import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Load .env before reading any env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
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
};

export function validateConfig(): void {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  }
}
