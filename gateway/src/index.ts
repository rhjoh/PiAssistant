import { config, validateConfig } from "./config.js"; // dotenv loaded here

import { PiRpcClient } from "./pi-rpc.js";
import { TelegramBot } from "./telegram.js";
import type { PiEvent, PiState } from "./types.js";

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
    let toolLabel = "tool";
    let toolMessageId: number | null = null;

    // Streaming state
    let responseMessageId: number | null = null;
    let sendingInitialMessage = false;
    let lastEditTime = 0;
    let lastEditedText = "";
    let pendingEdit: NodeJS.Timeout | null = null;
    const EDIT_THROTTLE_MS = 500;

    const onPiEvent = (event: PiEvent) => {
      if (event.type === "tool_execution_start") {
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

      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        if (event.toolName === "bash") {
          const command = extractCommandFromEvent(event);
          if (command) {
            toolLabel = `$ ${command}`;
          }
        }
      }
    };

    const onText = (currentText: string) => {
      const trimmed = currentText.trim();
      if (!trimmed) return;

      // First text - send initial message
      if (responseMessageId === null && !sendingInitialMessage) {
        sendingInitialMessage = true;
        void ctx
          .reply(trimmed)
          .then((msg) => {
            responseMessageId = msg.message_id;
            lastEditedText = trimmed;
            lastEditTime = Date.now();
          })
          .catch((err) => {
            console.error("[Telegram] Failed to send initial streaming message:", err);
            sendingInitialMessage = false; // Allow retry on failure
          });
        return;
      }

      // Still waiting for initial message to be sent
      if (responseMessageId === null) {
        return;
      }

      // Subsequent text - throttled edit
      const now = Date.now();
      const timeSinceLastEdit = now - lastEditTime;

      // Clear any pending edit
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }

      const doEdit = () => {
        if (trimmed === lastEditedText) return; // No change
        if (responseMessageId === null) return;

        // Truncate for Telegram limit
        const textToSend = trimmed.length > 4000 ? trimmed.slice(0, 4000) + "..." : trimmed;

        void ctx.api
          .editMessageText(ctx.chat!.id, responseMessageId, textToSend)
          .then(() => {
            lastEditedText = trimmed;
            lastEditTime = Date.now();
          })
          .catch((err) => {
            // Ignore "message is not modified" errors
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!errMsg.includes("message is not modified")) {
              console.error("[Telegram] Failed to edit streaming message:", err);
            }
          });
      };

      if (timeSinceLastEdit >= EDIT_THROTTLE_MS) {
        doEdit();
      } else {
        // Schedule edit for later
        pendingEdit = setTimeout(doEdit, EDIT_THROTTLE_MS - timeSinceLastEdit);
      }
    };

    pi.on("event", onPiEvent);
    pi.on("text", onText);

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    try {
      // Forward to Pi and wait for response
      const response = await pi.prompt(text);
      console.log(`[Pi] Response: ${response.slice(0, 100)}...`);

      // Clear any pending edit
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }

      // Final edit with complete response
      const trimmedResponse = response.trim();
      if (responseMessageId !== null && trimmedResponse && trimmedResponse !== lastEditedText) {
        // Handle long responses - if > 4096, we need to send additional messages
        if (trimmedResponse.length <= 4000) {
          try {
            await ctx.api.editMessageText(ctx.chat!.id, responseMessageId, trimmedResponse);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!errMsg.includes("message is not modified")) {
              console.error("[Telegram] Failed to edit final message:", err);
            }
          }
        } else {
          // Edit first message with truncated content, send rest as new messages
          const firstChunk = trimmedResponse.slice(0, 4000);
          try {
            await ctx.api.editMessageText(ctx.chat!.id, responseMessageId, firstChunk);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!errMsg.includes("message is not modified")) {
              console.error("[Telegram] Failed to edit final message:", err);
            }
          }
          // Send remaining chunks
          const remaining = trimmedResponse.slice(4000);
          await telegram.replyLong(ctx, remaining);
        }
      } else if (responseMessageId === null && trimmedResponse) {
        // No streaming happened (very fast response), send normally
        await telegram.replyLong(ctx, trimmedResponse);
      }

      // Update tool message to show completion (remove "Running..." status)
      if (toolMessageId !== null) {
        try {
          await ctx.api.editMessageText(ctx.chat!.id, toolMessageId, `✓ ${toolLabel}`);
        } catch {
          // Ignore errors updating tool status
        }
      }

      // Return undefined so telegram.ts doesn't send a duplicate
      return;
    } finally {
      // Clean up listeners even if prompt fails
      pi.off("event", onPiEvent);
      pi.off("text", onText);
      if (pendingEdit) {
        clearTimeout(pendingEdit);
      }
    }
  });

  // Wire up /status command
  telegram.onStatus(async (_ctx) => {
    const state = await pi.getState();
    const stateData = state.data as PiState;
    const activeModel = stateData?.model;

    const lines = [
      `Current model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(unknown)"}`,
      `Session: ${config.pi.sessionPath}`,
      `Running: ${pi.isRunning ? "yes" : "no"}`,
    ];

    return lines.join("\n");
  });

  // Wire up /model command
  telegram.onModel(async (_ctx, args) => {
    const arg = args.trim();

    if (!arg || arg === "") {
      const state = await pi.getState();
      const stateData = state.data as PiState;
      const activeModel = stateData?.model;

      return [
        `Current model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(unknown)"}`,
        "",
        "Usage:",
        "/model                    Show current model",
        "/model list               List available models",
        "/model <number>           Switch to model",
      ].join("\n");
    }

    if (arg === "list") {
      const response = await pi.getAvailableModels();
      if (!response.success || !response.data) {
        return "Failed to get available models.";
      }

      const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
      const models = data.models ?? [];

      const state = await pi.getState();
      const stateData = state.data as PiState;
      const currentModel = stateData?.model;

      const lines = models.map((m, i) => {
        const prefix = currentModel?.provider === m.provider && currentModel?.id === m.id ? "> " : "  ";
        return `${prefix}${i + 1}. ${m.provider}/${m.id} (${m.name})`;
      });

      return ["Available models:", ...lines].join("\n");
    }

    const index = parseInt(arg, 10);
    if (isNaN(index) || index < 1) {
      return "Invalid number. Use /model list to see available models.";
    }

    const response = await pi.getAvailableModels();
    if (!response.success || !response.data) {
      return "Failed to get available models.";
    }

    const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
    const models = data.models ?? [];

    if (index > models.length) {
      return `Model ${index} not found. Use /model list to see available models (1-${models.length}).`;
    }

    const selected = models[index - 1];

    try {
      await pi.setModelViaRpc(selected.provider, selected.id);
      return `Model changed to ${selected.provider}/${selected.id} (${selected.name})`;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      console.error("[Gateway] Failed to set model:", err);
      return `Failed to set model: ${errorMsg}`;
    }
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
