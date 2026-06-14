import type { BroadcastManager } from "../broadcast.js";
import type { TaskScheduler } from "../task-scheduler.js";
import type { TaskStore } from "../task-store.js";

export interface CommandContext {
  broadcastManager: BroadcastManager;
  taskStore?: TaskStore;
  taskScheduler?: TaskScheduler;
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

class StatusCommand implements Command {
  name = "status";
  async execute(_args: string[], ctx: CommandContext): Promise<string> {
    const state = await ctx.broadcastManager.getState();
    if (state.type === "state") {
      const s = state.data;
      const fmt = (n: number | undefined) => n?.toLocaleString() ?? "(n/a)";
      return [
        "Gateway status:",
        `Model: ${s.model ? `${s.model.provider}/${s.model.id} (${s.model.name})` : "(unknown)"}`,
        `Processing: ${s.isProcessing ? "yes" : "no"}`,
        `Context tokens: ${fmt(s.contextTokens)}`,
      ].join("\n");
    }
    return "Gateway status unavailable";
  }
}

class TaskCommand implements Command {
  name = "task";

  async execute(args: string[], ctx: CommandContext): Promise<string> {
    if (!ctx.taskStore || !ctx.taskScheduler) {
      return "Task scheduler is not available";
    }

    const [first, second] = args;
    if (!first || first === "list") {
      const tasks = ctx.taskStore.listTasks();
      if (tasks.length === 0) return "No scheduled tasks.";
      return tasks
        .map((task) => {
          const state = task.enabled ? "enabled" : "disabled";
          return `${task.id} — ${task.name} (${state})\n  cron: ${task.cron} ${task.timezone}\n  next: ${task.nextRun ?? "(none)"}`;
        })
        .join("\n\n");
    }

    if (first === "add") {
      return this.addTask(args.slice(1), {
        taskStore: ctx.taskStore,
        taskScheduler: ctx.taskScheduler,
      });
    }

    const taskId = first;
    const action = second;

    if (!action) {
      const task = ctx.taskStore.getTask(taskId);
      const runs = ctx.taskStore.listRuns(taskId, 5);
      const recentRuns = runs.length
        ? runs
            .map((run) => `  ${run.startedAt} ${run.status}${run.error ? ` — ${run.error}` : ""}`)
            .join("\n")
        : "  (none)";
      return [
        `${task.name} (${task.id})`,
        `Status: ${task.enabled ? "enabled" : "disabled"}`,
        `Cron: ${task.cron}`,
        `Timezone: ${task.timezone}`,
        `Next run: ${task.nextRun ?? "(none)"}`,
        `Last run: ${task.lastRun ?? "(never)"}`,
        "Recent runs:",
        recentRuns,
      ].join("\n");
    }

    if (action === "enable" || action === "disable") {
      const task = ctx.taskStore.updateTask(taskId, { enabled: action === "enable" });
      ctx.taskScheduler.refreshTask(task.id);
      return `${task.name} ${action === "enable" ? "enabled" : "disabled"}.`;
    }

    if (action === "run") {
      const run = await ctx.taskScheduler.runNow(taskId);
      return `Task run completed: ${run.status}${run.error ? ` — ${run.error}` : ""}`;
    }

    if (action === "remove") {
      ctx.taskScheduler.removeTask(taskId);
      ctx.taskStore.deleteTask(taskId);
      return `Task removed: ${taskId}`;
    }

    return "Usage: /task list | /task add <cron> <name> :: <prompt> | /task <id> enable|disable|run|remove";
  }

  private addTask(args: string[], ctx: Required<Pick<CommandContext, "taskStore" | "taskScheduler">>): string {
    const separatorIndex = args.indexOf("::");
    if (args.length < 3 || separatorIndex < 2) {
      return "Usage: /task add <cron> <name> :: <prompt>";
    }

    const cronExpression = args.slice(0, 5).join(" ");
    const remainder = args.slice(5);
    const actualSeparatorIndex = remainder.indexOf("::");
    if (actualSeparatorIndex < 1) {
      return "Usage: /task add <cron> <name> :: <prompt>";
    }

    const name = remainder.slice(0, actualSeparatorIndex).join(" ");
    const prompt = remainder.slice(actualSeparatorIndex + 1).join(" ");
    const task = ctx.taskStore.createTask({
      name,
      prompt,
      cron: cronExpression,
    });
    ctx.taskScheduler.refreshTask(task.id);
    return `Task created: ${task.name} (${task.id})`;
  }
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  constructor(private ctx: CommandContext) {
    this.register(new ModelCommand());
    this.register(new SessionCommand());
    this.register(new NewCommand());
    this.register(new StatusCommand());
    this.register(new TaskCommand());
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
