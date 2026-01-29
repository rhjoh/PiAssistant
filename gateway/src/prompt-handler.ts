import type { Context } from "grammy";
import type { PiRpcClient } from "./pi-rpc.js";
import type { TelegramBot } from "./telegram.js";
import type { PiEvent } from "./types.js";
import { escapeHtml } from "./telegram.js";

const EDIT_THROTTLE_MS = 500;

/**
 * Strip markdown code fences from text (```language ... ```)
 */
function stripCodeFences(text: string): string {
  // Remove opening fences like ```json, ```typescript, ``` etc
  // Remove closing fences
  return text
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/\n?```$/gm, "")
    .trim();
}

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

/**
 * Handle a user prompt: send to Pi, stream response to Telegram.
 * Manages tool status messages and response streaming with throttled edits.
 */
export async function handlePrompt(
  text: string,
  ctx: Context,
  pi: PiRpcClient,
  telegram: TelegramBot
): Promise<void> {
  console.log(`\n[Telegram] Received: ${text}`);

  // Track tool execution messages for this prompt (single placeholder)
  let toolsExecuted = false;
  let toolLabel = "tool";
  let toolMessageId: number | null = null;

  // Streaming state
  let responseMessageId: number | null = null;
  let sendingInitialMessage = false;
  let lastEditTime = 0;
  let lastEditedText = "";
  let pendingEdit: NodeJS.Timeout | null = null;

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
    
    // Format as HTML if tools were executed
    const formatResponse = (text: string): { text: string; parseMode?: "HTML" } => {
      if (toolsExecuted) {
        const cleaned = stripCodeFences(text);
        // Only include label if no tool status message (avoid duplication)
        const html = toolMessageId
          ? `<pre>${escapeHtml(cleaned)}</pre>`
          : `<b>${escapeHtml(toolLabel)}</b>\n<pre>${escapeHtml(cleaned)}</pre>`;
        return { text: html, parseMode: "HTML" };
      }
      return { text };
    };

    if (responseMessageId !== null && trimmedResponse && trimmedResponse !== lastEditedText) {
      // Handle long responses - if > 4096, we need to send additional messages
      if (trimmedResponse.length <= 4000) {
        const formatted = formatResponse(trimmedResponse);
        try {
          await ctx.api.editMessageText(ctx.chat!.id, responseMessageId, formatted.text, {
            parse_mode: formatted.parseMode,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("message is not modified")) {
            console.error("[Telegram] Failed to edit final message:", err);
          }
        }
      } else {
        // Edit first message with truncated content, send rest as new messages
        const firstChunk = trimmedResponse.slice(0, 4000);
        const formatted = formatResponse(firstChunk);
        try {
          await ctx.api.editMessageText(ctx.chat!.id, responseMessageId, formatted.text, {
            parse_mode: formatted.parseMode,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("message is not modified")) {
            console.error("[Telegram] Failed to edit final message:", err);
          }
        }
        // Send remaining chunks (plain text for overflow)
        const remaining = trimmedResponse.slice(4000);
        await telegram.replyLong(ctx, remaining);
      }
    } else if (responseMessageId === null && trimmedResponse) {
      // No streaming happened (very fast response), send normally
      if (toolsExecuted) {
        const cleaned = stripCodeFences(trimmedResponse);
        if (toolMessageId) {
          // Tool status exists, just send the code block
          await ctx.reply(`<pre>${escapeHtml(cleaned)}</pre>`, { parse_mode: "HTML" });
        } else {
          await telegram.replyWithToolOutput(ctx, toolLabel, cleaned);
        }
      } else {
        await telegram.replyLong(ctx, trimmedResponse);
      }
    }

    // Update tool message to show completion (remove "Running..." status)
    if (toolMessageId !== null) {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, toolMessageId, `✓ ${toolLabel}`);
      } catch {
        // Ignore errors updating tool status
      }
    }
  } finally {
    // Clean up listeners even if prompt fails
    pi.off("event", onPiEvent);
    pi.off("text", onText);
    if (pendingEdit) {
      clearTimeout(pendingEdit);
    }
  }
}
