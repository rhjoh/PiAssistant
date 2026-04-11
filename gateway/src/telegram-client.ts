import type { Context } from "grammy";
import type { TelegramBot } from "./telegram.js";
import type { Client, WSServerMessage } from "./types-ws.js";
import { config } from "./config.js";
import { escapeHtml, markdownToTelegramHtml } from "./telegram.js";

const TOOL_OUTPUT_MAX_CHARS = 1800;
const TOOL_OUTPUT_MAX_LINES = 30;

/**
 * TelegramClient adapts TelegramBot to the Client interface for BroadcastManager.
 * 
 * This allows Telegram to receive the same broadcasts as WebSocket clients,
 * with Telegram-specific rendering (HTML formatting, tool output in <pre> blocks, etc.)
 */
export class TelegramClient implements Client {
  id = "telegram";
  type = "telegram" as const;
  
  // Track message IDs for editing streamed responses
  private responseMessageId: number | null = null;
  private lastEditTime = 0;
  private lastEditedText = "";
  private pendingEdit: NodeJS.Timeout | null = null;
  private currentContext: Context | null = null;
  private accumulatedText = "";
  private draftId: number | null = null;
  private useDraftStreaming = false;
  private readonly EDIT_THROTTLE_MS = 1000;
  private readonly DRAFT_START_MIN_CHARS = 24;

  // Tool call tracking — map toolCallId → Telegram message ID
  private toolMessages = new Map<string, { messageId: number | null; label: string; pending: boolean }>();

  constructor(private bot: TelegramBot) {}

  /**
   * Set the current Telegram context (for sending responses)
   * This should be called when a new message arrives from Telegram
   */
  setContext(ctx: Context): void {
    this.currentContext = ctx;
    // Reset state for new conversation
    this.responseMessageId = null;
    this.lastEditedText = "";
    this.accumulatedText = "";
    this.toolMessages.clear();
    this.draftId = this.bot.getMessageDraftId(ctx);
    this.useDraftStreaming =
      config.telegram.useMessageDraftStreaming &&
      this.bot.canUseMessageDraft(ctx) &&
      this.draftId !== null;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
  }

  /**
   * Clear the current context (called when response is complete)
   */
  clearContext(): void {
    this.currentContext = null;
    this.responseMessageId = null;
    this.lastEditedText = "";
    this.accumulatedText = "";
    this.toolMessages.clear();
    this.draftId = null;
    this.useDraftStreaming = false;
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
  }

  isAvailable(): boolean {
    return this.currentContext !== null;
  }

  async send(message: WSServerMessage): Promise<void> {
    if (!this.currentContext) {
      console.warn("[TelegramClient] No context set, cannot send message");
      return;
    }

    const ctx = this.currentContext;

    switch (message.type) {
      case "text_delta":
        await this.handleTextDelta(ctx, message.data.content);
        break;

      case "tool_start":
        await this.handleToolStart(ctx, message.data.toolCallId, message.data.toolName, message.data.label);
        break;

      case "tool_output":
        await this.handleToolOutput(ctx, message.data.toolCallId, message.data.output, message.data.truncated);
        break;

      case "tool_end":
        // Tool completed — message already updated by tool_output
        break;

      case "done":
        await this.handleDone(ctx, message.data.finalText);
        break;

      case "error":
        await ctx.reply(`Error: ${message.data.message}`);
        this.clearContext();
        break;

      case "connection":
      case "state":
      case "history":
      case "thinking_delta":
      case "thinking_done":
        // These are not typically sent to Telegram
        break;
    }
  }

  // ── Text streaming ──────────────────────────────────────────────

  private async handleTextDelta(ctx: Context, content: string): Promise<void> {
    this.accumulatedText += content;

    const doEdit = async () => {
      const fullText = this.accumulatedText;
      if (fullText === this.lastEditedText) return;
      const textToSend = fullText.length > 4000 ? fullText.slice(0, 4000) + "…" : fullText;

      if (!this.currentContext) return;

      if (this.useDraftStreaming && this.draftId !== null && this.responseMessageId === null) {
        const visibleLength = textToSend.trim().length;
        if (visibleLength < this.DRAFT_START_MIN_CHARS) {
          return;
        }

        try {
          await this.bot.sendMessageDraft(ctx, this.draftId, textToSend);
          this.lastEditedText = fullText;
          this.lastEditTime = Date.now();
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errObj = err as { parameters?: { retry_after?: number } };
          if (errObj.parameters?.retry_after) {
            const retryMs = errObj.parameters.retry_after * 1000 + 100;
            setTimeout(doEdit, retryMs);
            return;
          }

          // Fallback to editMessageText streaming if drafts are unsupported.
          this.useDraftStreaming = false;
          console.warn(`[TelegramClient] sendMessageDraft unavailable, falling back to editMessageText: ${errMsg}`);
        }
      }

      if (this.responseMessageId === null) {
        try {
          const msg = await ctx.reply(textToSend);
          this.responseMessageId = msg.message_id;
          this.lastEditedText = fullText;
          this.lastEditTime = Date.now();
        } catch (err) {
          console.error("[TelegramClient] Failed to send initial message:", err);
        }
        return;
      }

      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          this.responseMessageId,
          textToSend
        );
        this.lastEditedText = fullText;
        this.lastEditTime = Date.now();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("message is not modified")) return;

        const errObj = err as { parameters?: { retry_after?: number } };
        if (errObj.parameters?.retry_after) {
          const retryMs = errObj.parameters.retry_after * 1000 + 100;
          setTimeout(doEdit, retryMs);
          return;
        }

        console.error("[TelegramClient] Failed to edit message:", err);
      }
    };

    // Throttle without resetting timers on every incoming token.
    if (this.pendingEdit) {
      return;
    }

    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;

    if (timeSinceLastEdit >= this.EDIT_THROTTLE_MS) {
      await doEdit();
    } else {
      this.pendingEdit = setTimeout(() => {
        this.pendingEdit = null;
        void doEdit();
      }, this.EDIT_THROTTLE_MS - timeSinceLastEdit);
    }
  }

  // ── Tool call rendering ─────────────────────────────────────────

  private async handleToolStart(ctx: Context, toolCallId: string, toolName: string, label: string): Promise<void> {
    const entry = { messageId: null as number | null, label, pending: true };
    this.toolMessages.set(toolCallId, entry);

    try {
      const html = `Running ${escapeHtml(label)}...`;
      const msg = await ctx.reply(html, { parse_mode: "HTML" });
      entry.messageId = msg.message_id;
      entry.pending = false;
    } catch (err) {
      console.error("[TelegramClient] Failed to send tool start:", err);
      entry.pending = false;
    }
  }

  private async handleToolOutput(ctx: Context, toolCallId: string, output: string, truncated?: boolean): Promise<void> {
    const entry = this.toolMessages.get(toolCallId);
    if (!entry) return;

    // If the tool start message hasn't been sent yet, wait briefly
    if (!entry.messageId) {
      if (entry.pending) {
        setTimeout(() => void this.handleToolOutput(ctx, toolCallId, output, truncated), 200);
        return;
      }
      return;
    }

    const truncatedOutput = this.truncateToolOutput(output);

    const hasOutput = truncatedOutput.length > 0;
    const html = hasOutput
      ? `${escapeHtml(entry.label)}\n<pre>${escapeHtml(truncatedOutput)}</pre>`
      : `${escapeHtml(entry.label)}`;

    try {
      await ctx.api.editMessageText(ctx.chat!.id, entry.messageId, html, { parse_mode: "HTML" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("message is not modified")) {
        console.error("[TelegramClient] Failed to update tool message:", err);
      }
    }
  }

  // ── Final response ──────────────────────────────────────────────

  private async handleDone(ctx: Context, finalText: string): Promise<void> {
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }

    // Final authoritative text from BroadcastManager/Pi
    this.accumulatedText = finalText || this.accumulatedText;
    const text = this.accumulatedText;

    if (this.useDraftStreaming && this.responseMessageId === null && text) {
      // Finalize by sending a regular message with HTML formatting.
      const html = markdownToTelegramHtml(text);
      await this.bot.replyLong(ctx, html, "HTML");
      this.clearContext();
      return;
    }

    if (this.responseMessageId !== null && text && text !== this.lastEditedText) {
      // Edit the existing streaming message with HTML-formatted final text.
      const html = markdownToTelegramHtml(text);

      try {
        if (html.length <= 4000) {
          await ctx.api.editMessageText(ctx.chat!.id, this.responseMessageId, html, { parse_mode: "HTML" });
        } else {
          const firstChunk = html.slice(0, 4000);
          await ctx.api.editMessageText(ctx.chat!.id, this.responseMessageId, firstChunk, { parse_mode: "HTML" });
          // Send remainder as new messages
          await this.bot.replyLong(ctx, html.slice(4000), "HTML");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!errMsg.includes("message is not modified")) {
          console.error("[TelegramClient] Failed to edit final message:", err);
        }
      }
    } else if (this.responseMessageId === null && text) {
      // No streaming happened — send as new message with HTML formatting
      const html = markdownToTelegramHtml(text);
      await this.bot.replyLong(ctx, html, "HTML");
    }

    this.clearContext();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private truncateToolOutput(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";

    let out = normalized;
    const lines = normalized.split("\n");

    if (lines.length > TOOL_OUTPUT_MAX_LINES) {
      out = lines.slice(0, TOOL_OUTPUT_MAX_LINES).join("\n") + "\n… (truncated)";
    }

    if (out.length > TOOL_OUTPUT_MAX_CHARS) {
      const truncated = out.slice(0, TOOL_OUTPUT_MAX_CHARS);
      const lastNewline = truncated.lastIndexOf("\n");
      const cutPoint = lastNewline > TOOL_OUTPUT_MAX_CHARS * 0.5 ? lastNewline : TOOL_OUTPUT_MAX_CHARS;
      out = out.slice(0, cutPoint) + "\n… (truncated)";
    }

    return out;
  }
}
