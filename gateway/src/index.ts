import { config, validateConfig } from "./config.js"; // dotenv loaded here

import { handleStatus, handleModel, handleSession, handleNew, handleTakeover } from "./commands.js";
import { handlePrompt } from "./prompt-handler.js";
import { PiRpcClient } from "./pi-rpc.js";
import { SessionManager } from "./session-manager.js";
import { SessionWatcher } from "./session-watcher.js";
import { TelegramBot } from "./telegram.js";
import { Heartbeat } from "./heartbeat.js";
import { MemoryWatcher } from "./memory-watcher.js";

// Add timestamps to all console output
function setupTimestampedLogging(): void {
  const timestamp = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  
  console.log = (...args) => originalLog(`[${timestamp()}]`, ...args);
  console.error = (...args) => originalError(`[${timestamp()}]`, ...args);
  console.warn = (...args) => originalWarn(`[${timestamp()}]`, ...args);
}

async function main(): Promise<void> {
  setupTimestampedLogging();
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

  // Session watcher (lock file-based TUI detection)
  const sessionWatcher = new SessionWatcher(
    config.pi.sessionPath,
    config.tui.lockPath,
  );

  sessionWatcher.on(async (event) => {
    if (event.type === "tui-detected") {
      if (pi.isRunning) {
        try { pi.abort(); } catch { /* ignore */ }
        pi.stop();
        console.log("[Gateway] Pi RPC stopped (TUI now owns session)");
      }
    } else if (event.type === "tui-gone") {
      console.log("[Gateway] TUI closed, restarting Pi RPC...");
      await pi.start();
      console.log("[Gateway] Pi RPC ready");
    }
  });

  // Check initial TUI status before starting Pi
  const initialStatus = await sessionWatcher.checkStatus();
  sessionWatcher.start();

  if (initialStatus === "active") {
    console.log("[Gateway] TUI active at startup — Pi RPC not started");
  } else {
    console.log("[Gateway] Starting Pi RPC...");
    await pi.start();
    console.log("[Gateway] Pi RPC ready");
  }

  // Wire up Telegram message handler
  telegram.onMessage(async (text, ctx) => {
    console.log(`[Telegram] Incoming message: ${text.slice(0, 100)}`);

    if (sessionWatcher.isTuiActive) {
      console.log("[Gateway] TUI active — blocking Telegram message");
      return "⚠️ TUI is active on this session. Send /takeover to reclaim.";
    }

    if (!pi.isRunning) {
      console.log("[Gateway] Pi RPC not running, starting...");
      await pi.start();
      console.log("[Gateway] Pi RPC ready");
    }

    await handlePrompt(text, ctx, pi, telegram);
  });

  // Wire up /status command
  telegram.onStatus(async () => handleStatus(pi, config.pi.sessionPath));

  // Wire up /model command
  telegram.onModel(async (_ctx, args) => handleModel(pi, args));

  // Wire up /session command
  telegram.onSession(async () => handleSession(sessionManager));

  // Wire up /new command (wired after memoryWatcher init below)

  // Wire up /takeover command
  telegram.onTakeover(async () => handleTakeover(pi, sessionWatcher));

  // Start heartbeat (proactive agent check-ins)
  const heartbeat = new Heartbeat(pi, (response) => {
    // Agent has something proactive to say - send to Telegram
    telegram.sendMessage(response).catch((err) => {
      console.error("[Gateway] Failed to send heartbeat response:", err);
    });
  }, config.pi.cwd, { intervalMs: config.heartbeat.intervalMs });
  heartbeat.start();

  // Start memory watcher
  const memoryWatcher = new MemoryWatcher({
    sessionDir: config.memory.sessionDir,
    outputDir: config.memory.outputDir,
    statePath: config.memory.statePath,
    model: config.memory.model,
    provider: config.memory.provider,
    intervalMs: config.memory.intervalMs,
    activeWindowMs: config.memory.activeWindowMs,
    memoryPromptPath: config.memory.memoryPromptPath,
  });

  // Wire up /new command (needs memoryWatcher reference)
  telegram.onNewSession(async () => handleNew(sessionManager, config.pi.sessionPath, memoryWatcher));

  if (config.memory.enabled) {
    await memoryWatcher.start();
    console.log(`[Gateway] Memory watcher started (${config.memory.intervalMs / 60000} min interval, ${config.memory.provider}/${config.memory.model})`);
  } else {
    console.log("[Gateway] Memory watcher disabled");
  }

  // Start Telegram bot
  console.log("[Gateway] Starting Telegram bot...");
  await telegram.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Gateway] Shutting down...");
    sessionWatcher.stop();
    memoryWatcher.stop();
    heartbeat.stop();
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
