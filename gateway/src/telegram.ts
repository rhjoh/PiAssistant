import { Bot, Context } from "grammy";
import { config } from "./config.js";

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
export type TakeoverHandler = (ctx: Context) => Promise<string | void>;

export class TelegramBot {
  private bot: Bot;
  private messageHandler: MessageHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private modelHandler: ModelHandler | null = null;
  private sessionHandler: SessionHandler | null = null;
  private newSessionHandler: NewSessionHandler | null = null;
  private takeoverHandler: TakeoverHandler | null = null;

  constructor() {
    this.bot = new Bot(config.telegram.token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply("Gateway connected. Send me a message to talk to Pi.");
    });

    // Handle /takeover command
    this.bot.command("takeover", async (ctx) => {
      if (!this.takeoverHandler) {
        await ctx.reply("No takeover handler configured.");
        return;
      }
      try {
        const response = await this.takeoverHandler(ctx);
        if (response) {
          await this.replyLong(ctx, response);
        }
      } catch (err) {
        console.error("[Telegram] Takeover handler error:", err);
        await ctx.reply(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    });

    // Handle /status command
    this.bot.command("status", async (ctx) => {
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

    // Handle /session command
    this.bot.command("session", async (ctx) => {
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

    // Handle /new command
    this.bot.command("new", async (ctx) => {
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
      // Security: only respond to whitelisted user
      if (config.telegram.allowedUserId && ctx.from?.id !== config.telegram.allowedUserId) {
        console.log(`[Telegram] Ignoring message from non-whitelisted user: ${ctx.from?.id}`);
        return;
      }

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

  onTakeover(handler: TakeoverHandler): void {
    this.takeoverHandler = handler;
  }

  async sendMessage(text: string): Promise<void> {
    if (!config.telegram.allowedUserId) {
      console.warn("[Telegram] No allowed user ID configured, cannot send message");
      return;
    }
    await this.bot.api.sendMessage(config.telegram.allowedUserId, text);
  }

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
  async replyLong(ctx: Context, text: string): Promise<void> {
    const maxLength = 4000;
    const chunks: string[] = [];

    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  async start(): Promise<void> {
    console.log("[Telegram] Starting bot...");
    await this.bot.start({
      onStart: () => console.log("[Telegram] Bot started"),
    });
  }

  stop(): void {
    this.bot.stop();
  }
}
