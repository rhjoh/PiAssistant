import type { BroadcastManager } from "../broadcast.js";

export interface CommandContext {
  broadcastManager: BroadcastManager;
}

export interface Command {
  name: string;
  execute(args: string[], ctx: CommandContext): Promise<string>;
}

class ModelCommand implements Command {
  name = "model";
  async execute(args: string[], ctx: CommandContext): Promise<string> {
    return ctx.broadcastManager.handleModelCommand(args[0] || "");
  }
}

class SessionCommand implements Command {
  name = "session";
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    return ctx.broadcastManager.handleSessionCommand();
  }
}

class NewCommand implements Command {
  name = "new";
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    return ctx.broadcastManager.handleNewCommand();
  }
}

class TakeoverCommand implements Command {
  name = "takeover";
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    return ctx.broadcastManager.handleTakeoverCommand();
  }
}

class StatusCommand implements Command {
  name = "status";
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    const state = await ctx.broadcastManager.getState();
    if (state.type === "state") {
      const s = state.data;
      return [
        "Gateway status:",
        `Model: ${s.provider && s.model ? `${s.provider}/${s.model}` : "(unknown)"}`,
        `Processing: ${s.isProcessing ? "yes" : "no"}`,
        `Context tokens: ${s.contextTokens ?? "(n/a)"}`,
      ].join("\n");
    }
    return "Gateway status unavailable";
  }
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  constructor(private ctx: CommandContext) {
    this.register(new ModelCommand());
    this.register(new SessionCommand());
    this.register(new NewCommand());
    this.register(new TakeoverCommand());
    this.register(new StatusCommand());
  }

  private register(command: Command): void {
    this.commands.set(command.name, command);
  }

  async execute(commandName: string, args: string[] = []): Promise<string> {
    const command = this.commands.get(commandName);
    if (!command) {
      throw new Error(`Unknown command: ${commandName}`);
    }
    return command.execute(args, this.ctx);
  }

  listCommands(): string[] {
    return Array.from(this.commands.keys());
  }
}
