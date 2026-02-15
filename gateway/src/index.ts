import { config, validateConfig } from "./config.js"; // dotenv loaded here

import { handleStatus, handleModel, handleSession, handleNew, handleTakeover } from "./commands.js";
import { PiRpcClient } from "./pi-rpc.js";
import { SessionManager } from "./session-manager.js";
import { TelegramBot } from "./telegram.js";
import { TelegramClient } from "./telegram-client.js";
import { BroadcastManager } from "./broadcast.js";
import { WebSocketGateway } from "./websocket-server.js";
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
  console.log(`[Gateway] Thinking level: ${config.pi.thinkingLevel}`);
  console.log(`[Gateway] Architecture: Gateway owns Pi RPC (multi-client mode)`);

  // Initialize Pi RPC client (will run continuously)
  const pi = new PiRpcClient(config.pi.sessionPath, config.pi.cwd);
  
  // Initialize BroadcastManager (handles multi-client message distribution)
  const broadcastManager = new BroadcastManager(pi);
  
  // Initialize session manager with archive notification
  const sessionManager = new SessionManager(pi, { 
    sessionPath: config.pi.sessionPath,
    onArchive: (archivePath, reason) => {
      const reasonText = reason === "compaction" ? "Context threshold reached" : "Manual rotation";
      console.log(`[SessionManager] Session archived: ${archivePath} (${reasonText})`);
    }
  });
  
  // Wire up session manager to broadcast manager for /new command
  broadcastManager.setSessionManager(sessionManager);
  
  // Initialize Telegram bot
  const telegram = new TelegramBot();
  const telegramClient = new TelegramClient(telegram);
  broadcastManager.registerClient(telegramClient);
  
  // Initialize WebSocket server for macOS and other clients
  const wsGateway = new WebSocketGateway(broadcastManager, 3456);

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
    // Auto-restart Pi if it crashes
    console.log("[Gateway] Restarting Pi RPC in 2 seconds...");
    setTimeout(() => {
      pi.start().catch((err) => {
        console.error("[Gateway] Failed to restart Pi RPC:", err);
      });
    }, 2000);
  });

  pi.on("error", (err) => {
    console.error("[Pi] Error:", err);
  });

  // Set up session management (archival on compaction)
  sessionManager.setupEventHandlers();

  // Start Pi RPC (Gateway owns the session now)
  console.log("[Gateway] Starting Pi RPC...");
  await pi.start(config.pi.thinkingLevel);
  console.log("[Gateway] Pi RPC ready");
  
  // Set thinking level via RPC if specified
  if (config.pi.thinkingLevel && config.pi.thinkingLevel !== "off") {
    try {
      await pi.setThinkingLevel(config.pi.thinkingLevel);
    } catch (err) {
      console.warn("[Gateway] Failed to set thinking level:", err);
    }
  }

  // Start WebSocket server
  console.log("[Gateway] Starting WebSocket server...");
  await wsGateway.start();

  // Wire up Telegram message handler
  telegram.onMessage(async (text, ctx) => {
    console.log(`[Telegram] Incoming message: ${text.slice(0, 100)}`);
    
    // Set context so TelegramClient knows where to send responses
    telegramClient.setContext(ctx);
    
    // Send prompt via BroadcastManager (will broadcast to all clients)
    await broadcastManager.sendPrompt(text, "telegram");
  });

  // Wire up /status command
  telegram.onStatus(async () => handleStatus(pi, config.pi.sessionPath));

  // Wire up /model command
  telegram.onModel(async (_ctx, args) => handleModel(pi, args));

  // Wire up /session command
  telegram.onSession(async () => handleSession(sessionManager));

  // Wire up /new command (wired after memoryWatcher init below)

  // Wire up /takeover command (now just for info - TUI handoff removed)
  telegram.onTakeover(async () => {
    return "Gateway owns the session. Native TUI is not available while Gateway is running.";
  });

  // Start heartbeat (proactive agent check-ins)
  const heartbeat = new Heartbeat(pi, (response) => {
    // Agent has something proactive to say - broadcast to all clients
    broadcastManager.broadcast({
      type: "proactive",
      data: { message: response },
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
  
  console.log("[Gateway] All systems operational");
  console.log(`[Gateway] Connected clients: ${broadcastManager.getClientCount()}`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Gateway] Shutting down...");
    heartbeat.stop();
    memoryWatcher.stop();
    wsGateway.stop();
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
