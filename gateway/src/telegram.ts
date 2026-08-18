import type { Context } from "grammy";
import { Bot } from "grammy";
import { config } from "./config.js";

// ── Rich Message API types (not yet in grammy — Bot API June 2026) ──

interface RichMessagePayload {
  markdown?: string;
  html?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

interface SendRichMessageArgs {
  chat_id: number | string;
  message_thread_id?: number;
  rich_message: RichMessagePayload;
  reply_parameters?: {
    message_id: number;
    chat_id?: number | string;
    allow_sending_without_reply?: boolean;
  };
  disable_notification?: boolean;
  protect_content?: boolean;
  message_effect_id?: string;
}

interface SendRichMessageDraftArgs {
  chat_id: number;
  message_thread_id?: number;
  draft_id: number;
  rich_message: RichMessagePayload;
}

/** Raw API with rich message methods — cast ctx.api.raw to this type. */
interface RichMessageRawApi {
  sendRichMessage(args: SendRichMessageArgs): Promise<{ ok: boolean; result: unknown }>;
  sendRichMessageDraft(args: SendRichMessageDraftArgs): Promise<{ ok: boolean; result: boolean }>;
}

/**
 * Escapes HTML special characters for safe use in Telegram HTML mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts Markdown to Telegram HTML.
 * Supports: **bold**, *italic*, `code`, ```code blocks```, ~~strikethrough~~, [links](url)
 */
export function markdownToTelegramHtml(text: string): string {
  // Use a placeholder approach to protect content we want to keep as-is
  const placeholders: string[] = [];
  const save = (content: string): string => {
    placeholders.push(content);
    return `\x00${placeholders.length - 1}\x00`;
  };
  const restore = (str: string): string => {
    return str.replace(/\x00(\d+)\x00/g, (_, i) => placeholders[parseInt(i, 10)]);
  };

  let html = text;

  // Code blocks (fenced) - process first
  html = html.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const escapedCode = escapeHtml(code.trimEnd());
      return save(`<pre>${lang ? `<code class="language-${lang}">` : '<code>'}${escapedCode}</code></pre>`);
    }
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, code) => save(`<code>${escapeHtml(code)}</code>`));

  // Bold - **text** or __text__
  html = html.replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (_, b1, b2) => save(`<b>${escapeHtml(b1 || b2)}</b>`));

  // Italic - *text* or _text_
  html = html.replace(/(?<![*\w])\*([^*]+?)\*(?![*\w])|(?<![_\w])_([^_]+?)_(?![_\w])/g, (_, i1, i2) => save(`<i>${escapeHtml(i1 || i2)}</i>`));

  // Strikethrough
  html = html.replace(/~~([^~]+?)~~/g, (_, s) => save(`<s>${escapeHtml(s)}</s>`));

  // Links
  html = html.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_, linkText, url) => {
    const safeUrl = url.startsWith('http') ? url : `https://${url}`;
    return save(`<a href="${safeUrl}">${escapeHtml(linkText)}</a>`);
  });

  // Escape remaining plain text
  html = escapeHtml(html);

  // Restore placeholders
  return restore(html);
}

/**
 * Formats assistant text for Telegram with Markdown→HTML conversion.
 * Wraps truncated content in spoilers.
 */
export function formatAssistantText(text: string, isTruncated = false): string {
  const html = markdownToTelegramHtml(text);
  if (isTruncated) {
    return `<tg-spoiler>${html}</tg-spoiler>`;
  }
  return html;
}

/**
 * Formats tool execution output for display in Telegram.
 *
 * @param toolName - The name of the tool (e.g., "bash", "read", "glob")
 * @param result - The raw result from tool execution (could be string, object, etc.)
 * @returns HTML-formatted string for Telegram
 */
export function formatToolOutput(toolName: string, result: unknown): string {
  // Convert result to string
  let output: string;
  if (typeof result === "string") {
    output = result;
  } else if (result === null || result === undefined) {
    output = "(no output)";
  } else {
    output = extractToolText(result);
  }

  // Truncate if too long (Telegram limit is 4096, leave room for formatting)
  const maxLength = 3800;
  if (output.length > maxLength) {
    output = output.slice(0, maxLength) + "\n... (truncated)";
  }

  const body = output;

  // Format with tool name header and code block
  return `Tool call: <b>${escapeHtml(toolName)}</b>\n<pre>${escapeHtml(body)}</pre>`;
}

function extractToolText(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return String(result);
  }

  const asRecord = result as Record<string, unknown>;

  const textField = asRecord.text;
  if (typeof textField === "string") {
    return textField;
  }

  const outputField = asRecord.output;
  if (typeof outputField === "string") {
    return outputField;
  }

  const stdout = asRecord.stdout;
  const stderr = asRecord.stderr;
  if (typeof stdout === "string" || typeof stderr === "string") {
    const out = typeof stdout === "string" ? stdout : "";
    const err = typeof stderr === "string" ? stderr : "";
    return [out, err].filter(Boolean).join("\n");
  }

  const content = asRecord.content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : null))
      .filter((value): value is string => typeof value === "string");
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result, null, 2);
}

export type MessageHandler = (
  text: string,
  ctx: Context
) => Promise<string | void>;

export type StatusHandler = (ctx: Context) => Promise<string | void>;

export type ModelHandler = (ctx: Context, args: string) => Promise<string | void>;

export type SessionHandler = (ctx: Context) => Promise<string | void>;

export type NewSessionHandler = (ctx: Context) => Promise<string | void>;

export type TaskHandler = (ctx: Context, args: string) => Promise<string | void>;

export class TelegramBot {
  private bot: Bot;
  private messageHandler: MessageHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private modelHandler: ModelHandler | null = null;
  private sessionHandler: SessionHandler | null = null;
  private newSessionHandler: NewSessionHandler | null = null;
  private taskHandler: TaskHandler | null = null;
  private abortHandler: ((ctx: Context) => Promise<void> | void) | null = null;

  constructor() {
    this.bot = new Bot(config.telegram.token);
    this.setupHandlers();
  }

  /**
   * Check that the user is authorized. Returns true only if
   * TELEGRAM_ALLOWED_USER_ID is configured and matches the sender.
   * If not configured, all access is denied (fail-closed).
   */
  private isAuthorized(ctx: Context): boolean {
    if (!config.telegram.allowedUserId) {
      console.warn("[Telegram] No TELEGRAM_ALLOWED_USER_ID configured, denying access");
      return false;
    }
    if (ctx.from?.id !== config.telegram.allowedUserId) {
      console.log("[Telegram] Unauthorized command ignored");
      return false;
    }
    return true;
  }

  private setupHandlers(): void {
    // Handle /start command
    this.bot.command("start", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      await ctx.reply("Gateway connected. Send me a message to talk to Pi.");
    });

    // Handle /status command
    this.bot.command("status", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.statusHandler) {
        await ctx.reply("No status handler configured.");
        return;
      }

      try {
        const response = await this.statusHandler(ctx);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Status handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle /model command
    this.bot.command("model", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.modelHandler) {
        await ctx.reply("No model handler configured.");
        return;
      }

      const text = ctx.message?.text ?? "";
      const args = text.split(" ").slice(1).join(" ").trim();

      try {
        const response = await this.modelHandler(ctx, args);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Model handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle /task command
    this.bot.command("task", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.taskHandler) {
        await ctx.reply("No task handler configured.");
        return;
      }

      const text = ctx.message?.text ?? "";
      const args = text.split(" ").slice(1).join(" ").trim();

      try {
        const response = await this.taskHandler(ctx, args);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Task handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle /session command
    this.bot.command("session", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.sessionHandler) {
        await ctx.reply("No session handler configured.");
        return;
      }

      try {
        const response = await this.sessionHandler(ctx);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Session handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle /stop command (abort current generation / stuck tool call)
    this.bot.command(["stop", "abort"], async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.abortHandler) {
        await ctx.reply("No abort handler configured.");
        return;
      }
      await this.abortHandler(ctx);
    });

    // Handle /new command
    this.bot.command("new", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;
      if (!this.newSessionHandler) {
        await ctx.reply("No new session handler configured.");
        return;
      }

      try {
        const response = await this.newSessionHandler(ctx);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] New session handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle all text messages
    this.bot.on("message:text", async (ctx) => {
      if (!this.isAuthorized(ctx)) return;

      const text = ctx.message.text;

      if (!this.messageHandler) {
        await ctx.reply("No message handler configured.");
        return;
      }

      try {
        const response = await this.messageHandler(text, ctx);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  onModel(handler: ModelHandler): void {
    this.modelHandler = handler;
  }

  onSession(handler: SessionHandler): void {
    this.sessionHandler = handler;
  }

  onNewSession(handler: NewSessionHandler): void {
    this.newSessionHandler = handler;
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  onAbort(handler: (ctx: Context) => Promise<void> | void): void {
    this.abortHandler = handler;
  }

  /**
   * Sends a message to the allowed user with HTML formatting.
   */

  // Causes duplicate messages when combined with sendMessageDraft() -- not sure of the draft/edit logic here.

  // async sendMessage(text: string): Promise<void> {
  //   if (!config.telegram.allowedUserId) {
  //     console.warn("[Telegram] No allowed user ID configured, cannot send message");
  //     return;
  //   }
  //   await this.bot.api.sendMessage(config.telegram.allowedUserId, text, { parse_mode: "HTML" });
  // }

  /**
   * Sends formatted tool output to Telegram with HTML formatting.
   * Handles formatting internally - just pass the raw tool data.
   */
  async sendToolOutput(toolName: string, result: unknown): Promise<void> {
    if (!config.telegram.allowedUserId) {
      console.warn("[Telegram] No allowed user ID configured, cannot send tool output");
      return;
    }
    const html = formatToolOutput(toolName, result);
    await this.bot.api.sendMessage(config.telegram.allowedUserId, html, { parse_mode: "HTML" });
  }

  /**
   * Reply to a message with formatted tool output (HTML code block).
   * Use this when the assistant's response is the result of a tool execution.
   */
  async replyWithToolOutput(ctx: Context, toolName: string, response: string): Promise<void> {
    const html = `<b>${escapeHtml(toolName)}</b>\n<pre>${escapeHtml(response)}</pre>`;
    await ctx.reply(html, { parse_mode: "HTML" });
  }

  /**
   * Sends a "tool running" message and returns the Telegram message id.
   */
  async replyToolStart(ctx: Context, toolName: string): Promise<number> {
    // Intentionally keep the command in regular text; actual stdout/stderr is shown in <pre> on completion.
    const html = `Running ${escapeHtml(toolName)}...`;
    const msg = await ctx.reply(html, { parse_mode: "HTML" });
    return msg.message_id;
  }

  /**
   * Updates an existing message with formatted tool output.
   */
  async updateToolOutput(ctx: Context, messageId: number, toolName: string, result: unknown): Promise<void> {
    const html = formatToolOutput(toolName, result);
    await ctx.api.editMessageText(ctx.chat!.id, messageId, html, { parse_mode: "HTML" });
  }

  /**
   * Updates an existing message with assistant prose (formatted as tool output).
   */
  async updateToolResponse(ctx: Context, messageId: number, toolName: string, response: string): Promise<void> {
    const html = `<b>${escapeHtml(toolName)}</b>\n<pre>${escapeHtml(response)}</pre>`;
    await ctx.api.editMessageText(ctx.chat!.id, messageId, html, { parse_mode: "HTML" });
  }

  /**
   * Sends formatted tool output as a new message (fallback).
   */
  async replyToolOutput(ctx: Context, toolName: string, result: unknown): Promise<void> {
    const html = formatToolOutput(toolName, result);
    await ctx.reply(html, { parse_mode: "HTML" });
  }

  /**
   * Returns whether this context can use sendMessageDraft.
   * Telegram only supports drafts in private chats.
   */
  canUseMessageDraft(ctx: Context): boolean {
    return ctx.chat?.type === "private" && typeof ctx.chat.id === "number" && ctx.chat.id > 0;
  }

  /**
   * Derive a stable draft id for this turn from update_id.
   */
  getMessageDraftId(ctx: Context): number | null {
    const update = ctx.update as { update_id?: number };
    if (typeof update.update_id !== "number" || update.update_id <= 0) {
      return null;
    }
    return update.update_id;
  }

  /**
   * Stream/update a draft message for in-progress generation.
   */
  async sendMessageDraft(ctx: Context, draftId: number, text: string): Promise<void> {
    if (!this.canUseMessageDraft(ctx)) {
      throw new Error("sendMessageDraft is only supported in private chats");
    }
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      throw new Error("Invalid chat_id for sendMessageDraft");
    }

    await ctx.api.sendMessageDraft(chatId, draftId, text);
  }

  // ── Rich Messages (Bot API June 2026) ──────────────────────────

  /** Whether rich messages can be used for this context. */
  canUseRichMessages(ctx: Context): boolean {
    if (!config.telegram.useRichMessages) return false;
    // Rich messages require a private chat (chat_id is a positive number)
    return ctx.chat?.type === "private" && typeof ctx.chat.id === "number" && ctx.chat.id > 0;
  }

  /** Get the raw API cast to the rich message interface. */
  private getRichApi(ctx: Context): RichMessageRawApi {
    return ctx.api.raw as unknown as RichMessageRawApi;
  }

  /**
   * Send a rich message. Uses the new sendRichMessage Bot API method.
   * Supports 32,768 chars, headings, tables, lists, code blocks, media, and more.
   */
  async sendRichMessage(ctx: Context, markdown: string): Promise<unknown> {
    const api = this.getRichApi(ctx);
    const replyTo = ctx.message?.message_id;
    return api.sendRichMessage({
      chat_id: ctx.chat!.id,
      rich_message: { markdown },
      ...(replyTo ? {
        reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
      } : {}),
    });
  }

  /**
   * Stream/update a rich message draft. Takes the same draft_id pattern as
   * sendMessageDraft but sends InputRichMessage content.
   * The draft is ephemeral (30s preview); finalize with sendRichMessage.
   */
  async sendRichMessageDraft(
    ctx: Context,
    draftId: number,
    markdown: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") {
      throw new Error("Private chat required for sendRichMessageDraft");
    }
    const api = this.getRichApi(ctx);
    await api.sendRichMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { markdown },
    });
  }

  /**
   * Build a rich message markdown document from assistant text and tool calls.
   * Tool calls are placed in a "## 🔧 Tool Calls" section at the bottom.
   * The assistant text is passed through as-is (rich markdown is a superset of
   * standard markdown — headings, lists, tables, code blocks all render natively).
   */
  buildRichMessageMarkdown(
    assistantText: string,
    toolCalls: Array<{ label: string; output: string; running: boolean }>,
  ): string {
    const parts: string[] = [];

    // Assistant response text (preserve original markdown formatting)
    if (assistantText) {
      parts.push(assistantText.trimEnd());
    } else if (toolCalls.length > 0) {
      parts.push("⏳ *Generating response…*");
    }

    // Tool calls section
    if (toolCalls.length > 0) {
      parts.push("");
      parts.push("## 🔧 Tool Calls");
      parts.push("");

      for (const tc of toolCalls) {
        // Escape backticks in label to avoid breaking the heading
        const safeLabel = tc.label.replace(/`/g, "\\`");
        if (tc.running) {
          parts.push(`### ${safeLabel} 🔄`);
          parts.push("```");
          parts.push("Running…");
          parts.push("```");
        } else if (tc.output) {
          // Truncate very long outputs
          const maxLen = 2000;
          const truncated =
            tc.output.length > maxLen
              ? tc.output.slice(0, maxLen) + "\n… (truncated)"
              : tc.output;
          parts.push(`### ${safeLabel}`);
          parts.push("```");
          parts.push(truncated);
          parts.push("```");
        } else {
          parts.push(`### ${safeLabel}`);
          parts.push("```");
          parts.push("(no output)");
          parts.push("```");
        }
        parts.push("");
      }
    }

    return parts.join("\n").trimEnd();
  }

  /**
   * Split a long message into chunks and send each separately.
   * Telegram has a 4096 character limit per message.
   */
  async sendMessageLong(text: string): Promise<void> {
    if (!config.telegram.allowedUserId) {
      console.warn("[Telegram] No allowed user ID configured, cannot send message");
      return;
    }

    const maxLength = 4000;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }

    for (const chunk of chunks) {
      await this.bot.api.sendMessage(config.telegram.allowedUserId, chunk);
    }
  }

  /**
   * Split a long message into chunks and reply to the context.
   */
  async replyLong(ctx: Context, text: string, parseMode?: "HTML" | "Markdown" | "MarkdownV2"): Promise<void> {
    const maxLength = 4000;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }

    for (const chunk of chunks) {
      if (parseMode) {
        await ctx.reply(chunk, { parse_mode: parseMode });
      } else {
        await ctx.reply(chunk);
      }
    }
  }

  async start(): Promise<void> {
    console.log("[Telegram] Starting bot...");

    // Register commands with Telegram so they appear in the / menu
    await this.bot.api.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "status", description: "Show Pi status and current model" },
      { command: "model", description: "View or change AI model" },
      { command: "session", description: "Show session info and stats" },
      { command: "new", description: "Archive session and start fresh" },
    ]);
    console.log("[Telegram] Commands registered");

    await this.bot.start({
      onStart: () => console.log("[Telegram] Bot started"),
    });
  }

  stop(): void {
    this.bot.stop();
  }
}
