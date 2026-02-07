import type { Context } from "grammy";
import type { PiRpcClient } from "./pi-rpc.js";
import type { TelegramBot } from "./telegram.js";
import type { PiEvent } from "./types.js";
import { escapeHtml } from "./telegram.js";

const EDIT_THROTTLE_MS = 1000;
// Keep tool output readable in Telegram: show enough for context but avoid wall-of-text.
const TOOL_OUTPUT_MAX_CHARS = 1800;
const TOOL_OUTPUT_MAX_LINES = 30;

function extractCommandFromUnknown(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

function extractCommandFromEvent(event: PiEvent): string | null {
  if (
    event.type !== "tool_execution_start" &&
    event.type !== "tool_execution_update" &&
    event.type !== "tool_execution_end"
  ) {
    return null;
  }
  const direct = extractCommandFromUnknown(event as unknown);
  if (direct) return direct;
  const fromResult = "result" in event ? extractCommandFromUnknown((event as Record<string, unknown>).result) : null;
  if (fromResult) return fromResult;
  const args = "args" in event ? extractCommandFromUnknown((event as Record<string, unknown>).args) : null;
  return args;
}

function extractArgsFromUnknown(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function formatToolLabel(toolName: string, args: unknown): string {
  if (toolName === "bash") {
    const cmd = extractCommandFromUnknown(args);
    return cmd ? `$ ${cmd}` : "bash";
  }

  const a = extractArgsFromUnknown(args);
  if (!a) return toolName;

  // Common patterns for built-in tools (keep this short so it reads like a terminal)
  const pathLike =
    (typeof a.path === "string" && a.path) ||
    (typeof a.filePath === "string" && a.filePath) ||
    (typeof a.filename === "string" && a.filename);
  if (pathLike) return `${toolName} ${pathLike}`;

  const patternLike = (typeof a.pattern === "string" && a.pattern) || (typeof a.glob === "string" && a.glob);
  if (patternLike) return `${toolName} ${patternLike}`;

  const urlLike = typeof a.url === "string" && a.url ? a.url : null;
  if (urlLike) return `${toolName} ${urlLike}`;

  const queryLike = typeof a.query === "string" && a.query ? a.query : null;
  if (queryLike) return `${toolName} ${queryLike}`;

  // Fallback: inline JSON (truncated) so you can see what the tool was called with.
  try {
    const json = JSON.stringify(args);
    if (!json) return toolName;
    const max = 140;
    return `${toolName} ${json.length > max ? json.slice(0, max - 1) + "…" : json}`;
  } catch {
    return toolName;
  }
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  if (Array.isArray(result)) {
    if (result.every((x) => typeof x === "string")) return (result as string[]).join("\n");
    return JSON.stringify(result, null, 2);
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    
    // Try common text fields
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
    if (typeof r.stdout === "string") {
      let out = r.stdout;
      if (typeof r.stderr === "string" && r.stderr) out += "\n" + r.stderr;
      return out;
    }
    if (Array.isArray(r.paths) && r.paths.every((x) => typeof x === "string")) return (r.paths as string[]).join("\n");
    if (Array.isArray(r.matches) && r.matches.every((x) => typeof x === "string")) return (r.matches as string[]).join("\n");
    
    // Handle content array (common in Pi tool results)
    if (Array.isArray(r.content)) {
      const textParts = r.content
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : null))
        .filter((value): value is string => typeof value === "string");
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
    
    // Fallback: return formatted JSON so we can see the structure
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

function truncateToolOutput(text: string, opts: { maxChars: number; maxLines: number }): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  let out = normalized;

  if (lines.length > opts.maxLines) {
    out = lines.slice(0, opts.maxLines).join("\n") + "\n… (truncated)";
  }

  if (out.length > opts.maxChars) {
    const truncated = out.slice(0, opts.maxChars);
    const lastNewline = truncated.lastIndexOf("\n");
    const cutPoint = lastNewline > opts.maxChars * 0.5 ? lastNewline : opts.maxChars;
    out = out.slice(0, cutPoint) + "\n… (truncated)";
  }

  return out;
}

/**
 * Handle a user prompt: send to Pi, stream response to Telegram.
 *
 * Tool calls are shown as:  ✓ $ command\n<pre>output</pre>
 * Agent prose is sent as a separate message after.
 */
export async function handlePrompt(
  text: string,
  ctx: Context,
  pi: PiRpcClient,
  telegram: TelegramBot
): Promise<void> {
  console.log(`\n[Telegram] Received: ${text}`);

  // Tool tracking — one message per tool call
  type ToolCall = {
    toolCallId: string;
    label: string;
    messageId: number | null;
    messagePending: boolean;
  };
  const toolCalls = new Map<string, ToolCall>();
  let currentToolCallId: string | null = null;
  const completedToolMessageIds: number[] = [];

  // Streaming state for agent prose (text after tool calls)
  let responseMessageId: number | null = null;
  let sendingInitialMessage = false;
  let lastEditTime = 0;
  let lastEditedText = "";
  let pendingEdit: NodeJS.Timeout | null = null;

  // Track whether we're mid-tool (suppress streamed text that is tool output)
  let insideTool = false;
  // Length of currentText to skip (accumulated during tool execution)
  let proseStartOffset = 0;

  const onPiEvent = (event: PiEvent) => {
    if (event.type === "tool_execution_start") {
      insideTool = true;

      const label = formatToolLabel(event.toolName || "tool", event.args);

      // Important: capture the tool object so fast tool completions don't race the reply promise.
      const tool: ToolCall = {
        toolCallId: event.toolCallId,
        label,
        messageId: null,
        messagePending: true,
      };
      toolCalls.set(event.toolCallId, tool);
      currentToolCallId = event.toolCallId;

      void telegram
        .replyToolStart(ctx, label)
        .then((messageId) => {
          tool.messageId = messageId;
          tool.messagePending = false;
        })
        .catch((err) => {
          console.error("[Telegram] Failed to send tool start message:", err);
          tool.messagePending = false;
        });
    }

    if (event.type === "tool_execution_update") {
      // Optional: could stream partial output into the tool message here.
      // For now, we only display the final result on tool_execution_end.
      return;
    }

    if (event.type === "tool_execution_end") {
      // If tools can ever overlap, only exit "insideTool" when none are active.
      // IMPORTANT: don't delete from the map until after we edit the tool message.
      if (currentToolCallId === event.toolCallId) currentToolCallId = null;

      // Mark current accumulated text length as "skip" — everything up to here is tool output
      proseStartOffset = pi.currentTextLength;

      const resultText = extractToolResultText(
        "result" in event ? (event as Record<string, unknown>).result : null
      );
      const truncated = truncateToolOutput(resultText, {
        maxChars: TOOL_OUTPUT_MAX_CHARS,
        maxLines: TOOL_OUTPUT_MAX_LINES,
      });

      // Update the tool message with output
      const tool = toolCalls.get(event.toolCallId);
      if (tool) {
        const updateToolMessage = () => {
          if (!tool.messageId) {
            if (tool.messagePending) {
              setTimeout(updateToolMessage, 200);
              return;
            }
            return;
          }

          const hasOutput = truncated.length > 0;
          const html = hasOutput
            ? `${escapeHtml(tool.label)}\n<pre>${escapeHtml(truncated)}</pre>`
            : `${escapeHtml(tool.label)}`;

          void ctx.api
            .editMessageText(ctx.chat!.id, tool.messageId, html, { parse_mode: "HTML" })
            .catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (!errMsg.includes("message is not modified")) {
                console.error("[Telegram] Failed to update tool message:", err);
              }
            });

          completedToolMessageIds.push(tool.messageId);
        };

        updateToolMessage();
      }

      // Cleanup after updating the message.
      toolCalls.delete(event.toolCallId);
      insideTool = toolCalls.size > 0;
    }
  };

  const onText = (currentText: string) => {
    // While inside a tool execution, ignore streamed text (it's tool output, not prose)
    if (insideTool) return;

    // Strip any text that was accumulated during tool execution
    const proseOnly = proseStartOffset > 0 ? currentText.slice(proseStartOffset) : currentText;
    const trimmed = proseOnly.trim();
    if (!trimmed) return;

    // First text after tools — send initial message
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
          sendingInitialMessage = false;
        });
      return;
    }

    if (responseMessageId === null) return;

    // Throttled edit
    const now = Date.now();
    const timeSinceLastEdit = now - lastEditTime;

    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }

    const doEdit = () => {
      if (trimmed === lastEditedText || responseMessageId === null) return;
      const textToSend = trimmed.length > 4000 ? trimmed.slice(0, 4000) + "…" : trimmed;

      void ctx.api
        .editMessageText(ctx.chat!.id, responseMessageId, textToSend)
        .then(() => {
          lastEditedText = trimmed;
          lastEditTime = Date.now();
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("message is not modified")) return;
          const errObj = err as { parameters?: { retry_after?: number } };
          if (errObj.parameters?.retry_after) {
            const retryMs = errObj.parameters.retry_after * 1000 + 100;
            console.log(`[Telegram] Rate limited, retrying in ${retryMs}ms`);
            setTimeout(doEdit, retryMs);
            return;
          }
          console.error("[Telegram] Failed to edit streaming message:", err);
        });
    };

    if (timeSinceLastEdit >= EDIT_THROTTLE_MS) {
      doEdit();
    } else {
      pendingEdit = setTimeout(doEdit, EDIT_THROTTLE_MS - timeSinceLastEdit);
    }
  };

  pi.on("event", onPiEvent);
  pi.on("text", onText);

  await ctx.replyWithChatAction("typing");

  try {
    const response = await pi.prompt(text);
    console.log(`[Pi] Response: ${response.slice(0, 100)}...`);

    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }

    // Final response — the prose part only (strip tool output prefix)
    const proseResponse = proseStartOffset > 0 ? response.slice(proseStartOffset) : response;
    const trimmedResponse = proseResponse.trim();

    if (responseMessageId !== null && trimmedResponse && trimmedResponse !== lastEditedText) {
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
        const firstChunk = trimmedResponse.slice(0, 4000);
        try {
          await ctx.api.editMessageText(ctx.chat!.id, responseMessageId, firstChunk);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!errMsg.includes("message is not modified")) {
            console.error("[Telegram] Failed to edit final message:", err);
          }
        }
        await telegram.replyLong(ctx, trimmedResponse.slice(4000));
      }
    } else if (responseMessageId === null && trimmedResponse) {
      // No streaming happened — send normally
      await telegram.replyLong(ctx, trimmedResponse);
    }
  } finally {
    pi.off("event", onPiEvent);
    pi.off("text", onText);
    if (pendingEdit) {
      clearTimeout(pendingEdit);
    }
  }
}
