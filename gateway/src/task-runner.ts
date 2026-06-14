import type { BroadcastManager } from "./broadcast.js";
import type { TaskRecord, TaskRunRecord, TaskRunTrigger, TaskStore } from "./task-store.js";

export class TaskRunner {
  constructor(
    private taskStore: TaskStore,
    private broadcastManager: BroadcastManager
  ) {}

  async runTask(taskId: string, trigger: TaskRunTrigger): Promise<TaskRunRecord> {
    const task = this.taskStore.getTask(taskId);
    const renderedPrompt = renderTaskPrompt(task, new Date());
    const run = this.taskStore.createRun({
      taskId,
      renderedPrompt,
      trigger,
    });

    try {
      const result = await this.broadcastManager.sendTaskPrompt({
        taskId,
        runId: run.id,
        taskName: task.name,
        prompt: renderedPrompt,
      });
      const completed = this.taskStore.completeRun(run.id, summarizeResult(result));
      this.taskStore.updateRunTimes(taskId, { lastRun: completed.finishedAt });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.taskStore.failRun(run.id, message);
      this.taskStore.updateRunTimes(taskId, { lastRun: failed.finishedAt });
      throw error;
    }
  }
}

export function renderTaskPrompt(task: TaskRecord, now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: task.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value])
  );

  const values: Record<string, string> = {
    ...task.variables,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day_of_week: parts.weekday,
    time: `${parts.hour}:${parts.minute}`,
  };

  return task.prompt.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

function summarizeResult(result: string): string {
  const normalized = result.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty response)";
  return normalized.length > 1000 ? `${normalized.slice(0, 997)}...` : normalized;
}
