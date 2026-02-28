import { config, validateConfig } from "./config.js"; // dotenv loaded here
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleStatus, handleModel, handleSession, handleNew } from "./commands.js";
import { PiRpcClient } from "./pi-rpc.js";
import { SessionManager } from "./session-manager.js";
import { TelegramBot } from "./telegram.js";
import { TelegramClient } from "./telegram-client.js";
import { BroadcastManager } from "./broadcast.js";
import { WebSocketGateway } from "./websocket-server.js";
import { Heartbeat } from "./heartbeat.js";
import { MemoryWatcher } from "./memory-watcher.js";
import { FileServer } from "./file-server.js";
import { installTimestampedConsole } from "./logging.js";
import { GatewayStatusProvider } from "./gateway-status.js";

export async function startGateway(): Promise<void> {
  installTimestampedConsole(config.runtime.logFile);

  validateConfig();

  console.log("[Gateway] Starting Personal OS Gateway...");
  console.log(`[Gateway] Pi session: ${config.pi.sessionPath}`);
  console.log(`[Gateway] Thinking level: ${config.pi.thinkingLevel}`);
  console.log(`[Gateway] Image dir: ${config.images.dir}`);
  console.log(`[Gateway] Log file: ${config.runtime.logFile}`);
  console.log("[Gateway] Architecture: Gateway owns Pi RPC (multi-client mode)");

  // Ensure runtime and session directories exist.
  const sessionDir = dirname(config.pi.sessionPath);
  if (!existsSync(sessionDir)) {
    await mkdir(sessionDir, { recursive: true });
    console.log(`[Gateway] Created session directory: ${sessionDir}`);
  }
  await mkdir(config.runtime.runDir, { recursive: true });
  await mkdir(config.runtime.logsDir, { recursive: true });

  const pi = new PiRpcClient(config.pi.sessionPath, config.pi.cwd);
  const broadcastManager = new BroadcastManager(pi);
  const sessionManager = new SessionManager(pi, {
    sessionPath: config.pi.sessionPath,
    onArchive: (archivePath, reason) => {
      const reasonText = reason === "compaction" ? "Context threshold reached" : "Manual rotation";
      console.log(`[SessionManager] Session archived: ${archivePath} (${reasonText})`);
    },
  });
  broadcastManager.setSessionManager(sessionManager);

  const telegram = new TelegramBot();
  const telegramClient = new TelegramClient(telegram);
  broadcastManager.registerClient(telegramClient);

  const wsGateway = new WebSocketGateway(broadcastManager, pi, 3456);
  const fileServer = new FileServer(config.fileServer.port, [config.images.dir], 3456);

  // Initialize status provider
  const statusProvider = new GatewayStatusProvider(
    broadcastManager,
    pi,
    config.pi.sessionPath,
    3456,
    config.heartbeat.intervalMs,
    config.memory.intervalMs,
    config.memory.enabled
  );
  fileServer.setStatusProvider(statusProvider);

  pi.on("event", (event) => {
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown>;
      let detail = "";
      if (event.toolName === "bash" && typeof args?.command === "string") {
        detail = ` - ${args.command}`;
      } else if (
        (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") &&
        typeof args?.path === "string"
      ) {
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

  pi.on("toolResult", (toolName) => {
    console.log(`[Pi] Tool completed: ${toolName}`);
  });

  pi.on("exit", (code) => {
    console.log(`[Pi] Process exited with code ${code}`);
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

  sessionManager.setupEventHandlers();

  console.log("[Gateway] Starting Pi RPC...");
  await pi.start(config.pi.thinkingLevel);
  console.log("[Gateway] Pi RPC ready");

  if (config.pi.thinkingLevel && config.pi.thinkingLevel !== "off") {
    try {
      await pi.setThinkingLevel(config.pi.thinkingLevel);
    } catch (err) {
      console.warn("[Gateway] Failed to set thinking level:", err);
    }
  }

  console.log("[Gateway] Starting WebSocket server...");
  await wsGateway.start();
  statusProvider.setWebsocketRunning(true);

  console.log("[Gateway] Starting file server...");
  await fileServer.start();

  telegram.onMessage(async (text, ctx) => {
    console.log(`[Telegram] Incoming message: ${text.slice(0, 100)}`);
    telegramClient.setContext(ctx);
    await broadcastManager.sendPrompt(text, "telegram");
  });

  telegram.onStatus(async () => handleStatus(pi, config.pi.sessionPath));
  telegram.onModel(async (_ctx, args) => handleModel(pi, args));
  telegram.onSession(async () => handleSession(sessionManager));
  telegram.onTakeover(async () => {
    return "Gateway owns the session. Native TUI is not available while Gateway is running.";
  });

  const heartbeat = new Heartbeat(
    pi,
    (response) => {
      broadcastManager.broadcast({
        type: "proactive",
        data: { message: response },
      });
    },
    config.pi.cwd,
    { intervalMs: config.heartbeat.intervalMs, onTick: () => statusProvider.recordHeartbeat() }
  );
  heartbeat.start();

  const memoryWatcher = new MemoryWatcher({
    sessionDir: config.memory.sessionDir,
    outputDir: config.memory.outputDir,
    statePath: config.memory.statePath,
    model: config.memory.model,
    provider: config.memory.provider,
    intervalMs: config.memory.intervalMs,
    activeWindowMs: config.memory.activeWindowMs,
    memoryPromptPath: config.memory.memoryPromptPath,
    onTick: () => statusProvider.recordMemoryWatcherRun(),
  });

  telegram.onNewSession(async () => handleNew(sessionManager, config.pi.sessionPath, memoryWatcher));

  if (config.memory.enabled) {
    await memoryWatcher.start();
    console.log(
      `[Gateway] Memory watcher started (${config.memory.intervalMs / 60000} min interval, ${config.memory.provider}/${config.memory.model})`
    );
  } else {
    console.log("[Gateway] Memory watcher disabled");
  }

  console.log("[Gateway] Starting Telegram bot...");
  await telegram.start();
  console.log("[Gateway] All systems operational");
  console.log(`[Gateway] Connected clients: ${broadcastManager.getClientCount()}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[Gateway] Shutting down...");
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

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  startGateway().catch((err) => {
    console.error("[Gateway] Fatal error:", err);
    process.exit(1);
  });
}
