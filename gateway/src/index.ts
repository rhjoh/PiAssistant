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
import { ApiServer } from "./api-server.js";
import { installTimestampedConsole } from "./logging.js";
import { GatewayStatusProvider } from "./gateway-status.js";
import { OllamaEmbeddingClient } from "./memory-embeddings.js";
import { MemoryStore } from "./memory-store.js";
import { DailyContextManager } from "./daily-context.js";
import { TaskStore } from "./task-store.js";
import { TaskRunner } from "./task-runner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { CommandRegistry } from "./handlers/commands.js";

export async function startGateway(): Promise<void> {
  installTimestampedConsole(config.runtime.logFile);

  validateConfig();

  console.log("[Gateway] Starting Personal OS Gateway...");
  console.log(`[Gateway] Pi session: ${config.pi.sessionPath}`);
  if (config.pi.model) {
    const configuredModel = config.pi.provider ? `${config.pi.provider}/${config.pi.model}` : config.pi.model;
    console.log(`[Gateway] Pi startup model: ${configuredModel}`);
  } else {
    console.log("[Gateway] Pi startup model: session default");
  }
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

  const memoryStore = new MemoryStore({
    dbPath: config.memory.dbPath,
    briefingPath: config.memory.briefingPath,
    embeddingClient: new OllamaEmbeddingClient({
      host: config.memory.embeddingHost,
      model: config.memory.embeddingModel,
    }),
  });
  await memoryStore.init();
  await memoryStore.writeBriefingFile({ maxItems: config.memory.briefingMaxItems });
  console.log(`[Gateway] Memory DB: ${config.memory.dbPath}`);
  console.log(`[Gateway] Memory briefing: ${config.memory.briefingPath}`);
  console.log(`[Gateway] User profile: ${config.memory.userProfilePath}`);
  console.log(`[Gateway] Memory embeddings: ${config.memory.embeddingHost} (${config.memory.embeddingModel})`);

  const taskStore = new TaskStore({
    dbPath: config.tasks.dbPath,
    defaultTimezone: config.tasks.timezone,
  });
  await taskStore.init();
  console.log(`[Gateway] Task DB: ${config.tasks.dbPath}`);

  const memoryExtensions = existsSync(config.memory.toolsExtensionPath)
    ? [config.memory.toolsExtensionPath]
    : [];
  if (memoryExtensions.length === 0) {
    console.warn(`[Gateway] Memory tools extension not found: ${config.memory.toolsExtensionPath}`);
  }

  const pi = new PiRpcClient(config.pi.sessionPath, config.pi.cwd, {
    extensions: memoryExtensions,
    provider: config.pi.provider,
    model: config.pi.model,
  });
  const broadcastManager = new BroadcastManager(pi, {
    broadcastThinking: config.broadcast.thinkingEnabled,
  });
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

  const taskRunner = new TaskRunner(taskStore, broadcastManager);
  const taskScheduler = new TaskScheduler(taskStore, taskRunner, {
    enabled: config.tasks.enabled,
  });

  const wsGateway = new WebSocketGateway(
    broadcastManager,
    pi,
    config.webSocket.port,
    config.webSocket.host,
    taskStore,
    taskScheduler
  );

  const apiServer = new ApiServer(
    config.apiServer.port,
    [config.images.dir],
    config.webSocket.port,
    config.apiServer.host
  );
  apiServer.setMemoryStore(memoryStore);
  apiServer.setTaskServices(taskStore, taskScheduler);

  // Initialize status provider
  const statusProvider = new GatewayStatusProvider(
    broadcastManager,
    pi,
    config.pi.sessionPath,
    config.webSocket.port,
    config.webSocket.host,
    config.heartbeat.intervalMs
  );
  apiServer.setStatusProvider(statusProvider);
  apiServer.setSessionManager(sessionManager);

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

  console.log("[Gateway] Starting API server...");
  await apiServer.start();
  taskScheduler.init();

  telegram.onMessage(async (text, ctx) => {
    console.log(`[Telegram] Incoming message: ${text.slice(0, 100)}`);
    telegramClient.setContext(ctx);
    await broadcastManager.sendPrompt(text, "telegram");
  });

  telegram.onStatus(async () => handleStatus(pi, config.pi.sessionPath));
  telegram.onModel(async (_ctx, args) => handleModel(pi, args));
  telegram.onSession(async () => handleSession(sessionManager));
  const telegramCommandRegistry = new CommandRegistry({
    broadcastManager,
    taskStore,
    taskScheduler,
  });
  telegram.onTask(async (_ctx, args) => {
    return telegramCommandRegistry.execute("task", args ? args.split(/\s+/) : []);
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
    {
      intervalMs: config.heartbeat.intervalMs,
      quietWindowMs: Math.max(config.heartbeat.intervalMs, 15 * 60 * 1000),
      onTick: () => statusProvider.recordHeartbeat(),
      isBusy: () => broadcastManager.isPromptInFlight(),
      hasRecentUserActivity: (windowMs) => broadcastManager.hasRecentUserActivity(windowMs),
    }
  );
  heartbeat.start();

  const dailyContext = new DailyContextManager({
    sessionDir: config.memory.sessionDir,
    statePath: config.memory.dailyContextStatePath,
    todayPath: config.memory.todayPath,
    dailyDir: config.memory.dailyArchiveDir,
    intervalMs: config.memory.dailyContextIntervalMs,
    dailyExtractionHour: config.memory.dailyExtractionHour,
    provider: config.memory.provider,
    model: config.memory.model,
    cwd: config.pi.cwd,
    memoryStore,
    briefingPath: config.memory.briefingPath,
    maxTranscriptChars: config.memory.dailyContextMaxTranscriptChars,
    onTick: () => statusProvider.recordDailyContextRun(),
    isBusy: () => pi.isPromptActive,
  });

  telegram.onNewSession(async () => handleNew(sessionManager, config.pi.sessionPath));

  if (config.memory.dailyContextEnabled) {
    await dailyContext.start();
    console.log(
      `[Gateway] Daily context started (${config.memory.dailyContextIntervalMs / 60000} min interval, today=${config.memory.todayPath})`
    );
  } else {
    console.log("[Gateway] Daily context disabled");
  }

  // Wire daily context to API server for manual trigger
  if (dailyContext) {
    apiServer.setDailyContext(dailyContext);
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
    dailyContext.stop();
    taskScheduler.stop();
    wsGateway.stop();
    apiServer.stop();
    telegram.stop();
    pi.stop();
    taskStore.close();
    memoryStore.close();
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
