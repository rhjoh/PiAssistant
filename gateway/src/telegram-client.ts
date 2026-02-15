import type { Context } from "grammy";
import type { TelegramBot } from "./telegram.js";
import type { Client, WSServerMessage } from "./types-ws.js";
import { escapeHtml } from "./telegram.js";

/**
 * TelegramClient adapts TelegramBot to the Client interface for BroadcastManager.
 * 
 * This allows Telegram to receive the same broadcasts as WebSocket clients.
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
  private readonly EDIT_THROTTLE_MS = 1000;

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
        await this.handleToolStart(ctx, message.data.label);
        break;

      case "tool_output":
        // Tool output is handled by updating the tool start message
        // This is done by the prompt-handler currently
        break;

      case "tool_end":
        // Tool completed
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
        // These are not typically sent to Telegram
        break;
    }
  }

  private async handleTextDelta(ctx: Context, content: string): Promise<void> {
    // BroadcastManager sends delta chunks, so accumulate locally for Telegram edits.
    this.accumulatedText += content;

    // First text - send initial message
    if (this.responseMessageId === null) {
      try {
        const initial = this.accumulatedText;
        const msg = await ctx.reply(initial);
        this.responseMessageId = msg.message_id;
        this.lastEditedText = initial;
        this.lastEditTime = Date.now();
      } catch (err) {
        console.error("[TelegramClient] Failed to send initial message:", err);
      }
      return;
    }

    // Throttled edit
    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;

    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }

    const doEdit = async () => {
      if (!this.currentContext || this.responseMessageId === null) return;

      const fullText = this.accumulatedText;
      if (fullText === this.lastEditedText) return;
      const textToSend = fullText.length > 4000 ? fullText.slice(0, 4000) + "…" : fullText;

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

    if (timeSinceLastEdit >= this.EDIT_THROTTLE_MS) {
      await doEdit();
    } else {
      this.pendingEdit = setTimeout(doEdit, this.EDIT_THROTTLE_MS - timeSinceLastEdit);
    }
  }

  private async handleToolStart(ctx: Context, label: string): Promise<void> {
    // Send tool start message (will be updated with output later)
    try {
      const html = `Running ${escapeHtml(label)}...`;
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[TelegramClient] Failed to send tool start:", err);
    }
  }

  private async handleDone(ctx: Context, finalText: string): Promise<void> {
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }

    // Final authoritative text from BroadcastManager/Pi
    this.accumulatedText = finalText || this.accumulatedText;

    if (this.responseMessageId !== null && this.accumulatedText && this.accumulatedText !== this.lastEditedText) {
      try {
        if (this.accumulatedText.length <= 4000) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            this.responseMessageId,
            this.accumulatedText
          );
        } else {
          const firstChunk = this.accumulatedText.slice(0, 4000);
          await ctx.api.editMessageText(
            ctx.chat!.id,
            this.responseMessageId,
            firstChunk
          );
          // Send remainder as new messages
          await this.bot.replyLong(ctx, this.accumulatedText.slice(4000));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!errMsg.includes("message is not modified")) {
          console.error("[TelegramClient] Failed to edit final message:", err);
        }
      }
    } else if (this.responseMessageId === null && finalText) {
      // No streaming happened - send as new message
      await this.bot.replyLong(ctx, finalText);
    }

    this.clearContext();
  }
}
