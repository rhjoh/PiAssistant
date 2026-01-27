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

export class TelegramBot {
  private bot: Bot;
  private messageHandler: MessageHandler | null = null;

  constructor() {
    this.bot = new Bot(config.telegram.token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply("Gateway connected. Send me a message to talk to Pi.");
    });

    // Handle /takeover command (for Phase 2)
    this.bot.command("takeover", async (ctx) => {
      await ctx.reply("Takeover command received. (Not yet implemented)");
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
          await ctx.reply(response);
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
    const html = `Running <b>${escapeHtml(toolName)}</b>...`;
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
