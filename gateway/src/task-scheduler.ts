import cron, { type ScheduledTask } from "node-cron";
import type { TaskRecord, TaskRunRecord, TaskStore } from "./task-store.js";
import type { TaskRunner } from "./task-runner.js";

export class TaskScheduler {
  private scheduledTasks = new Map<string, ScheduledTask>();

  constructor(
    private taskStore: TaskStore,
    private taskRunner: TaskRunner,
    private options: {
      enabled: boolean;
    }
  ) {}

  init(): void {
    if (!this.options.enabled) {
      console.log("[TaskScheduler] Disabled");
      return;
    }

    const tasks = this.taskStore.listEnabledTasks();
    for (const task of tasks) {
      this.schedule(task);
    }
    console.log(`[TaskScheduler] Registered ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
  }

  stop(): void {
    for (const task of this.scheduledTasks.values()) {
      task.stop();
      task.destroy();
    }
    this.scheduledTasks.clear();
    console.log("[TaskScheduler] Stopped");
  }

  refreshTask(taskId: string): void {
    this.unschedule(taskId);
    const task = this.taskStore.getTask(taskId);
    if (task.enabled) {
      this.schedule(task);
    } else {
      this.taskStore.updateRunTimes(task.id, { nextRun: null });
    }
  }

  removeTask(taskId: string): void {
    this.unschedule(taskId);
  }

  async runNow(taskId: string): Promise<TaskRunRecord> {
    const run = await this.taskRunner.runTask(taskId, "manual");
    this.refreshTask(taskId);
    return run;
  }

  private schedule(task: TaskRecord): void {
    if (!this.options.enabled) return;

    this.unschedule(task.id);
    const scheduledTask = cron.schedule(
      task.cron,
      () => {
        this.taskRunner
          .runTask(task.id, "scheduled")
          .then(() => this.safeRefreshTask(task.id))
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[TaskScheduler] Task failed (${task.id}): ${message}`);
            this.safeRefreshTask(task.id);
          });
      },
      {
        timezone: task.timezone,
        name: task.id,
        noOverlap: true,
      }
    );

    this.scheduledTasks.set(task.id, scheduledTask);
    const nextRun = scheduledTask.getNextRun();
    this.taskStore.updateRunTimes(task.id, {
      nextRun: nextRun ? nextRun.toISOString() : null,
    });
    console.log(`[TaskScheduler] Scheduled ${task.id} (${task.name}) next=${nextRun?.toISOString() ?? "none"}`);
  }

  private safeRefreshTask(taskId: string): void {
    try {
      this.refreshTask(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[TaskScheduler] Could not refresh task ${taskId}: ${message}`);
      this.unschedule(taskId);
    }
  }

  private unschedule(taskId: string): void {
    const existing = this.scheduledTasks.get(taskId);
    if (!existing) return;
    existing.stop();
    existing.destroy();
    this.scheduledTasks.delete(taskId);
  }
}
