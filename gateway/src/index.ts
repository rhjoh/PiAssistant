import { config, validateConfig } from "./config.js"; // dotenv loaded here
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { handleStatus, handleModel, handleSession, handleNew, handleTakeover } from "./commands.js";
import { PiRpcClient } from "./pi-rpc.js";
import { SessionManager } from "./session-manager.js";
import { TelegramBot } from "./telegram.js";
import { TelegramClient } from "./telegram-client.js";
import { BroadcastManager } from "./broadcast.js";
import { WebSocketGateway } from "./websocket-server.js";
import { Heartbeat } from "./heartbeat.js";
import { MemoryWatcher } from "./memory-watcher.js";
import { FileServer } from "./file-server.js";

// Simple timestamp prefix for logs
const ts = () => new Date().toISOString().slice(11, 23);

// Prefix all console output with timestamp for consistent gateway logs
const installTimestampedConsole = (): void => {
  const patch = (method: "log" | "info" | "warn" | "error") => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (args.length === 0) return original(`[${ts()}]`);
      const [first, ...rest] = args;
      if (typeof first === "string" && first.startsWith("[")) {
        original(`[${ts()}] ${first}`, ...rest);
      } else {
        original(`[${ts()}]`, first, ...rest);
      }
    };
  };

  patch("log");
  patch("info");
  patch("warn");
  patch("error");
};

async function main(): Promise<void> {
  installTimestampedConsole();

  // Validate environment
  validateConfig();

  console.log(`[${ts()}] [Gateway] Starting Personal OS Gateway...`);
  console.log(`[${ts()}] [Gateway] Pi session: ${config.pi.sessionPath}`);
  console.log(`[${ts()}] [Gateway] Thinking level: ${config.pi.thinkingLevel}`);
  console.log(`[${ts()}] [Gateway] Image dir: ${config.images.dir}`);
  console.log(`[${ts()}] [Gateway] Architecture: Gateway owns Pi RPC (multi-client mode)`);

  // Ensure session directory exists
  const sessionDir = dirname(config.pi.sessionPath);
  if (!existsSync(sessionDir)) {
    await mkdir(sessionDir, { recursive: true });
    console.log(`[${ts()}] [Gateway] Created session directory: ${sessionDir}`);
  }

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
  
  // Initialize WebSocket server for macOS, Pi TUI, and other clients
  const wsGateway = new WebSocketGateway(broadcastManager, pi, 3456);

  // Wire up Pi events for logging
  pi.on("event", (event) => {
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown>;
      let detail = "";
      if (event.toolName === "bash" && typeof args?.command === "string") {
        detail = ` - ${args.command}`;
      } else if ((event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") && typeof args?.path === "string") {
        detail = ` - ${args.path}`;
      } else if (typeof args?.path === "string") {
        detail = ` - ${args.path}`;
      } else if (typeof args?.pattern === "string") {
        detail = ` - ${args.pattern}`;
      } else if (typeof args?.query === "string") {
        detail = ` - ${args.query}`;
      }
      console.log(`[Pi] Tool: ${event.toolName}${detail}`);
    }
  });

  pi.on("toolResult", (toolName, _result) => {
    console.log(`[Pi] Tool completed: ${toolName}`);
  });

  pi.on("exit", (code) => {
    console.log(`[${ts()}] [Pi] Process exited with code ${code}`);
    // Auto-restart Pi if it crashes
    console.log(`[${ts()}] [Gateway] Restarting Pi RPC in 2 seconds...`);
    setTimeout(() => {
      pi.start().catch((err) => {
        console.error(`[${ts()}] [Gateway] Failed to restart Pi RPC:`, err);
      });
    }, 2000);
  });

  pi.on("error", (err) => {
    console.error("[Pi] Error:", err);
  });

  // Set up session management (archival on compaction)
  sessionManager.setupEventHandlers();

  // Start Pi RPC (Gateway owns the session now)
  console.log(`[${ts()}] [Gateway] Starting Pi RPC...`);
  await pi.start(config.pi.thinkingLevel);
  console.log(`[${ts()}] [Gateway] Pi RPC ready`);
  
  // Set thinking level via RPC if specified
  if (config.pi.thinkingLevel && config.pi.thinkingLevel !== "off") {
    try {
      await pi.setThinkingLevel(config.pi.thinkingLevel);
    } catch (err) {
      console.warn("[Gateway] Failed to set thinking level:", err);
    }
  }

  // Start WebSocket server
  console.log(`[${ts()}] [Gateway] Starting WebSocket server...`);
  await wsGateway.start();

  // Start file server for serving images to web UI
  const fileServer = new FileServer(config.fileServer.port, [config.images.dir]);
  await fileServer.start();

  // Wire up Telegram message handler
  telegram.onMessage(async (text, ctx) => {
    console.log(`[${ts()}] [Telegram] Incoming message: ${text.slice(0, 100)}`);

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
    console.log(`[${ts()}] [Gateway] Memory watcher started (${config.memory.intervalMs / 60000} min interval, ${config.memory.provider}/${config.memory.model})`);
  } else {
    console.log(`[${ts()}] [Gateway] Memory watcher disabled`);
  }

  // Start Telegram bot
  console.log(`[${ts()}] [Gateway] Starting Telegram bot...`);
  await telegram.start();
  
  console.log(`[${ts()}] [Gateway] All systems operational`);
  console.log(`[${ts()}] [Gateway] Connected clients: ${broadcastManager.getClientCount()}`);

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[${ts()}] [Gateway] Shutting down...`);
    heartbeat.stop();
    memoryWatcher.stop();
    wsGateway.stop();
    fileServer.stop();
    telegram.stop();
    pi.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[${ts()}] [Gateway] Fatal error:`, err);
  process.exit(1);
});
