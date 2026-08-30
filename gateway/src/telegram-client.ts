import type { Context } from "grammy";
import type { TelegramBot } from "./telegram.js";
import type { Client, WSServerMessage } from "./types-ws.js";
import { config } from "./config.js";
import { escapeHtml, markdownToTelegramHtml } from "./telegram.js";

const TOOL_OUTPUT_MAX_CHARS = 1800;
const TOOL_OUTPUT_MAX_LINES = 30;

/** Rich-mode tool output truncation — richer messages can hold more. */
const RICH_TOOL_OUTPUT_MAX_CHARS = 2000;

interface ToolCallEntry {
  label: string;
  output: string;
  running: boolean;
  /** Legacy: Telegram message ID for separate tool message */
  messageId: number | null;
  pending: boolean;
}

/** Chronological event for interleaved rich message rendering. */
type RichEvent =
  | { type: "text"; content: string }
  | { type: "tool"; id: string };

/**
 * TelegramClient adapts TelegramBot to the Client interface for BroadcastManager.
 * 
 * This allows Telegram to receive the same broadcasts as WebSocket clients,
 * with Telegram-specific rendering (HTML formatting, tool output in <pre> blocks, etc.)
 */
export class TelegramClient implements Client {
  id = "telegram";
  type = "telegram" as const;

  // ── Legacy mode state ──────────────────────────────────────────
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

  // Tool call tracking — map toolCallId → entry (shared by both modes)
  private toolCalls = new Map<string, ToolCallEntry>();

  // ── Rich mode state ────────────────────────────────────────────
  private richMode = false;
  private richEvents: RichEvent[] = []; // chronological interleaving

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
    this.toolCalls.clear();
    this.richEvents = [];
    this.draftId = this.bot.getMessageDraftId(ctx);

    // Determine mode: rich messages if enabled and in a private chat
    this.richMode = this.bot.canUseRichMessages(ctx);

    if (this.richMode) {
      // Rich mode: always use draft streaming via sendRichMessageDraft
      this.useDraftStreaming = true;
    } else {
      this.useDraftStreaming =
        config.telegram.useMessageDraftStreaming &&
        this.bot.canUseMessageDraft(ctx) &&
        this.draftId !== null;
    }

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
    this.toolCalls.clear();
    this.richEvents = [];
    this.draftId = null;
    this.useDraftStreaming = false;
    this.richMode = false;
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

      case "notify": {
        const kind = message.data.notifyType ?? "info";
        const prefix = kind === "error" ? "Error" : kind === "warning" ? "Warning" : "Notice";
        await ctx.reply(`${prefix}: ${message.data.message}`);
        break;
      }

      case "extension_error":
        await ctx.reply(`Extension error: ${message.data.message}`);
        break;

      case "extension_ui_request": {
        if (["select", "confirm", "input", "editor"].includes(message.data.method)) {
          const title = message.data.title || message.data.message || "Pi is waiting for your answer";
          const options = message.data.options?.length
            ? `\n${message.data.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n")}`
            : "";
          await ctx.reply(
            `${title}${options}\n\nAnswer this in the desktop client — Telegram cannot submit the choice.`
          );
        }
        break;
      }

      case "connection":
      case "state":
      case "history":
      case "thinking_delta":
      case "thinking_done":
      case "extension_ui_resolved":
      case "image":
      case "proactive":
      case "usage":
      case "prompt_accepted":
      case "prompt_queued":
      case "queue_update":
      case "abort_complete":
      case "response_segment_done":
      case "models":
      case "model_switched":
      case "thinking_levels":
      case "thinking_level_changed":
      case "pong":
      case "ping":
      case "user_message":
        break;

      default:
        break;
    }
  }

  // ── Text streaming ──────────────────────────────────────────────

  private async handleTextDelta(ctx: Context, content: string): Promise<void> {
    this.accumulatedText += content;

    if (this.richMode) {
      const lastEvent = this.richEvents[this.richEvents.length - 1];
      if (lastEvent && lastEvent.type === "text") {
        lastEvent.content += content;
      } else {
        this.richEvents.push({ type: "text", content });
      }
      await this.flushRichDraft();
      return;
    }

    // ── Legacy mode ──────────────────────────────────────────────

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
    const entry: ToolCallEntry = { label, output: "", running: true, messageId: null, pending: true };
    this.toolCalls.set(toolCallId, entry);

    if (this.richMode) {
      // Rich mode: record event for chronological interleaving
      this.richEvents.push({ type: "tool", id: toolCallId });
      await this.flushRichDraft();
      return;
    }

    // ── Legacy mode: send separate tool message ──────────────────
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
    const entry = this.toolCalls.get(toolCallId);
    if (!entry) return;

    entry.output = output;
    entry.running = false;

    if (this.richMode) {
      // Rich mode: update the draft with tool output
      await this.flushRichDraft();
      return;
    }

    // ── Legacy mode: edit the separate tool message ──────────────

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

    if (this.richMode) {
      // Rich mode: send the final rich message.
      // If we were streaming via drafts, this creates the permanent message.
      // If no draft was sent (short response), this sends it directly.
      const markdown = this.buildRichDocument();
      try {
        await this.bot.sendRichMessage(ctx, markdown);
      } catch (err) {
        console.error("[TelegramClient] sendRichMessage failed:", err);
        // Fallback to legacy send if rich fails for any reason
        await this.fallbackSendLegacy(ctx);
      }
      this.clearContext();
      return;
    }

    // ── Legacy mode ──────────────────────────────────────────────

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

  // ── Rich message helpers ────────────────────────────────────────

  /**
   * Build the current rich markdown document with chronologically interleaved
   * text and tool calls (tool output appears where it ran, not at the bottom).
   */
  private buildRichDocument(): string {
    const parts: string[] = [];
    let hasContent = false;

    for (const event of this.richEvents) {
      if (event.type === "text") {
        const trimmed = event.content.trimEnd();
        if (trimmed) {
          parts.push(trimmed);
          hasContent = true;
        }
      } else {
        const tc = this.toolCalls.get(event.id);
        if (!tc) continue;
        const safeLabel = tc.label.replace(/`/g, "\\`");
        if (tc.running) {
          parts.push(`### ${safeLabel} 🔄`);
          parts.push("```");
          parts.push("Running…");
          parts.push("```");
        } else {
          const output = tc.output || "(no output)";
          const truncated =
            output.length > RICH_TOOL_OUTPUT_MAX_CHARS
              ? output.slice(0, RICH_TOOL_OUTPUT_MAX_CHARS) + "\n… (truncated)"
              : output;
          parts.push(`### ${safeLabel}`);
          parts.push("```");
          parts.push(truncated);
          parts.push("```");
        }
        hasContent = true;
        parts.push("");
      }
    }

    // Fallback: if no events yet but we have accumulated text
    if (!hasContent && this.accumulatedText) {
      parts.push(this.accumulatedText.trimEnd());
    }

    return parts.join("\n").trimEnd();
  }

  /**
   * Flush the current state to the rich message draft, with throttling.
   */
  private async flushRichDraft(): Promise<void> {
    if (!this.currentContext || this.draftId === null) return;

    const doFlush = async () => {
      if (!this.currentContext || this.draftId === null) return;
      const markdown = this.buildRichDocument();
      // Don't send empty or unchanged drafts
      if (!markdown || markdown === this.lastEditedText) return;

      try {
        await this.bot.sendRichMessageDraft(this.currentContext, this.draftId, markdown);
        this.lastEditedText = markdown;
        this.lastEditTime = Date.now();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errObj = err as { parameters?: { retry_after?: number } };
        if (errObj.parameters?.retry_after) {
          const retryMs = errObj.parameters.retry_after * 1000 + 100;
          setTimeout(doFlush, retryMs);
          return;
        }
        console.error("[TelegramClient] sendRichMessageDraft failed:", errMsg);
      }
    };

    // Throttle: don't flood the API with draft updates
    if (this.pendingEdit) return;

    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;

    if (timeSinceLastEdit >= this.EDIT_THROTTLE_MS) {
      await doFlush();
    } else {
      this.pendingEdit = setTimeout(() => {
        this.pendingEdit = null;
        void doFlush();
      }, this.EDIT_THROTTLE_MS - timeSinceLastEdit);
    }
  }

  /**
   * Fallback: send the accumulated text using legacy HTML formatting.
   * Used when sendRichMessage fails.
   */
  private async fallbackSendLegacy(ctx: Context): Promise<void> {
    const text = this.accumulatedText;
    if (!text) return;
    const html = markdownToTelegramHtml(text);
    try {
      await this.bot.replyLong(ctx, html, "HTML");
    } catch (err) {
      console.error("[TelegramClient] Legacy fallback also failed:", err);
    }
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
