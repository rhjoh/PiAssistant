import { config, validateConfig } from "./config.js"; // dotenv loaded here

import { handleStatus, handleModel, handleSession, handleNew } from "./commands.js";
import { handlePrompt } from "./prompt-handler.js";
import { PiRpcClient } from "./pi-rpc.js";
import { SessionManager } from "./session-manager.js";
import { TelegramBot } from "./telegram.js";

async function main(): Promise<void> {
  // Validate environment
  validateConfig();

  console.log("[Gateway] Starting Personal OS Gateway...");
  console.log(`[Gateway] Pi session: ${config.pi.sessionPath}`);

  // Initialize components
  const pi = new PiRpcClient(config.pi.sessionPath, config.pi.cwd);
  const telegram = new TelegramBot();
  
  // Initialize session manager with archive notification
  const sessionManager = new SessionManager(pi, { 
    sessionPath: config.pi.sessionPath,
    onArchive: (archivePath, reason) => {
      const reasonText = reason === "compaction" ? "Context threshold reached" : "Manual rotation";
      const message = [
        `🔄 Session archived`,
        ``,
        `Reason: ${reasonText}`,
        `Archived: ${archivePath}`,
        reason === "compaction" ? `New session started automatically` : ``,
      ].filter(Boolean).join("\n");
      
      telegram.sendMessage(message).catch((err) => {
        console.error("[Gateway] Failed to send archive notification:", err);
      });
    }
  });

  // Wire up Pi events for logging
  pi.on("event", (event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[Pi] Tool: ${event.toolName}`);
    }
  });

  pi.on("toolResult", (toolName, _result) => {
    console.log(`[Pi] Tool completed: ${toolName}`);
  });

  pi.on("exit", (code) => {
    console.log(`[Pi] Process exited with code ${code}`);
  });

  pi.on("error", (err) => {
    console.error("[Pi] Error:", err);
  });

  // Set up session management (archival on compaction)
  sessionManager.setupEventHandlers();

  // Wire up Telegram message handler
  telegram.onMessage(async (text, ctx) => {
    if (!pi.isRunning) {
      return "Pi is not running. Starting...";
    }
    await handlePrompt(text, ctx, pi, telegram);
  });

  // Wire up /status command
  telegram.onStatus(async () => handleStatus(pi, config.pi.sessionPath));

  // Wire up /model command
  telegram.onModel(async (_ctx, args) => handleModel(pi, args));

  // Wire up /session command
  telegram.onSession(async () => handleSession(sessionManager));

  // Wire up /new command
  telegram.onNewSession(async () => handleNew(sessionManager));

  // Start Pi RPC
  console.log("[Gateway] Starting Pi RPC...");
  await pi.start();
  console.log("[Gateway] Pi RPC ready");

  // Start Telegram bot
  console.log("[Gateway] Starting Telegram bot...");
  await telegram.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Gateway] Shutting down...");
    telegram.stop();
    pi.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[Gateway] Fatal error:", err);
  process.exit(1);
});
