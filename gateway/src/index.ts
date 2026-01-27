import { config, validateConfig } from "./config.js"; // dotenv loaded here

// Debug: check if env vars loaded
console.log("[Debug] TELEGRAM_BOT_TOKEN:", config.telegram.token ? `${config.telegram.token.slice(0, 10)}...` : "NOT SET");
import { PiRpcClient } from "./pi-rpc.js";
import { TelegramBot } from "./telegram.js";
import type { PiEvent } from "./types.js";

function extractCommandFromUnknown(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const asRecord = value as Record<string, unknown>;
  const command = asRecord.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

function extractCommandFromEvent(event: PiEvent): string | null {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") {
    return null;
  }

  const direct = extractCommandFromUnknown(event as unknown);
  if (direct) return direct;

  const fromResult = "result" in event ? extractCommandFromUnknown((event as Record<string, unknown>).result) : null;
  if (fromResult) return fromResult;

  const args = "args" in event ? extractCommandFromUnknown((event as Record<string, unknown>).args) : null;
  if (args) return args;

  return null;
}

async function main(): Promise<void> {
  // Validate environment
  validateConfig();

  console.log("[Gateway] Starting Personal OS Gateway...");
  console.log(`[Gateway] Pi session: ${config.pi.sessionPath}`);

  // Initialize components
  const pi = new PiRpcClient(config.pi.sessionPath, config.pi.cwd);
  const telegram = new TelegramBot();

  // Wire up Pi events for logging
  pi.on("event", (event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[Pi] Tool: ${event.toolName}`);
    }
  });

  // Log tool results (raw JSONL not useful to show in Telegram)
  pi.on("toolResult", (toolName, _result) => {
    console.log(`[Pi] Tool completed: ${toolName}`);
  });

  pi.on("exit", (code) => {
    console.log(`[Pi] Process exited with code ${code}`);
  });

  pi.on("error", (err) => {
    console.error("[Pi] Error:", err);
  });

  // Wire up Telegram message handler
  telegram.onMessage(async (text, ctx) => {
    console.log(`\n[Telegram] Received: ${text}`);

    if (!pi.isRunning) {
      return "Pi is not running. Starting...";
    }

    // Track tool execution messages for this prompt (single placeholder)
    let toolsExecuted = false;
    let toolLabel = "tool";
    let toolMessageId: number | null = null;
    const onPiEvent = (event: PiEvent) => {
      if (event.type === "tool_execution_start") {
        toolsExecuted = true;
        if (toolMessageId === null) {
          toolLabel = event.toolName || "tool";
          void telegram
            .replyToolStart(ctx, toolLabel)
            .then((messageId) => {
              toolMessageId = messageId;
            })
            .catch((err) => {
              console.error("[Telegram] Failed to send tool start message:", err);
            });
        }
      }

      if (event.toolName === "bash") {
        const command = extractCommandFromEvent(event);
        if (command) {
          toolLabel = `$ ${command}`;
        }
      }
    };
    pi.on("event", onPiEvent);

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    try {
      // Forward to Pi and wait for response
      const response = await pi.prompt(text);
      console.log(`[Pi] Response: ${response.slice(0, 100)}...`);

      if (toolsExecuted && response.trim()) {
        if (toolMessageId !== null) {
          await telegram.updateToolResponse(ctx, toolMessageId, toolLabel, response);
        } else {
          await telegram.replyWithToolOutput(ctx, toolLabel, response);
        }
        return;
      }

      return response;
    } finally {
      // Clean up listener even if prompt fails
      pi.off("event", onPiEvent);
    }
  });

  // Wire up /status command
  telegram.onStatus(async (_ctx) => {
    const state = await pi.getState();
    const model = (state.data as { model?: unknown } | undefined)?.model ?? null;
    if (!model) {
      return "Current model: (none)";
    }
    return `Current model:\\n${JSON.stringify(model, null, 2)}`;
  });

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
