import cron, { type ScheduledTask } from "node-cron";
import type { TaskRecord, TaskRunRecord, TaskStore } from "./task-store.js";
import type { TaskRunner } from "./task-runner.js";

const DEFAULT_WATCHDOG_INTERVAL_MS = 60 * 1000; // 1 minute

export interface TaskSchedulerOptions {
  enabled: boolean;
  /** Missed-run grace period in ms. 0 = skip missed runs and advance metadata. */
  missedRunGraceMs?: number;
  /** How often the stale-task watchdog runs. Defaults to 60s. */
  watchdogIntervalMs?: number;
}

export class TaskScheduler {
  private scheduledTasks = new Map<string, ScheduledTask>();
  private staleCheckTimer: NodeJS.Timeout | null = null;
  private inflightTaskIds = new Set<string>();

  constructor(
    private taskStore: TaskStore,
    private taskRunner: TaskRunner,
    private options: TaskSchedulerOptions
  ) {}

  init(): void {
    if (!this.options.enabled) {
      console.log("[TaskScheduler] Disabled");
      return;
    }

    const tasks = this.taskStore.listEnabledTasks();

    // Snapshot persisted nextRun BEFORE scheduling overwrites it, so we can
    // detect tasks that went stale while the gateway was down.
    const staleOnStartup = new Map<string, string | null>();
    for (const task of tasks) {
      if (task.nextRun) {
        const ms = Date.parse(task.nextRun);
        if (!Number.isNaN(ms) && ms <= Date.now()) {
          staleOnStartup.set(task.id, task.nextRun);
        }
      }
    }

    for (const task of tasks) {
      this.schedule(task);
    }
    console.log(`[TaskScheduler] Registered ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);

    // Repair stale tasks using the pre-scheduling snapshot.
    this.reconcileStaleTasks(new Date(), staleOnStartup);

    // Start periodic watchdog for ongoing self-healing.
    const intervalMs = this.options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.staleCheckTimer = setInterval(() => {
      this.reconcileStaleTasks();
    }, intervalMs);
    this.staleCheckTimer.unref();
  }

  stop(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    for (const task of this.scheduledTasks.values()) {
      task.stop();
      task.destroy();
    }
    this.scheduledTasks.clear();
    console.log("[TaskScheduler] Stopped");
  }

  /**
   * Full unregister/register cycle. Used when cron/timezone/enabled changes.
   * Fetches the task first so a missing/deleted task doesn't destroy an
   * existing schedule unnecessarily.
   */
  refreshTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (task.enabled) {
      this.schedule(task);
    } else {
      this.unschedule(taskId);
      this.taskStore.updateRunTimes(task.id, { nextRun: null });
    }
  }

  removeTask(taskId: string): void {
    this.unschedule(taskId);
  }

  async runNow(taskId: string): Promise<TaskRunRecord> {
    const run = await this.taskRunner.runTask(taskId, "manual");
    // Don't destroy/recreate the cron timer for a manual run — only
    // recompute nextRun metadata for the existing scheduled task.
    this.recomputeNextRun(taskId);
    return run;
  }

  /**
   * Health check. Scans enabled tasks for stale nextRun metadata and
   * missing cron registrations, repairing both. Called on startup and
   * periodically by the watchdog timer.
   *
   * For startup reconciliation, pass a `staleSnapshot` captured BEFORE
   * scheduling runs, since schedule() overwrites nextRun.
   */
  reconcileStaleTasks(now = new Date(), staleSnapshot?: Map<string, string | null>): void {
    if (!this.options.enabled) return;

    const graceMs = this.options.missedRunGraceMs ?? 0;
    const tasks = this.taskStore.listEnabledTasks();

    for (const task of tasks) {
      // Ensure a live cron handle exists for every enabled task.
      if (!this.scheduledTasks.has(task.id)) {
        console.warn(
          `[TaskScheduler] Task ${task.id} (${task.name}) has no live cron handle - re-registering`
        );
        this.schedule(task);
      }

      // Use the pre-scheduling snapshot on startup, otherwise the current
      // DB value (which the watchdog sees as the persisted truth).
      const nextRunStr = staleSnapshot?.has(task.id) ? staleSnapshot.get(task.id)! : task.nextRun;
      const nextRunMs = nextRunStr ? Date.parse(nextRunStr) : null;
      if (nextRunMs === null || Number.isNaN(nextRunMs) || nextRunMs > now.getTime()) {
        continue; // not stale
      }

      const staleMs = now.getTime() - nextRunMs;
      const withinGrace = graceMs > 0 && staleMs <= graceMs;

      if (withinGrace && !this.inflightTaskIds.has(task.id)) {
        console.warn(
          `[TaskScheduler] Task ${task.id} (${task.name}) missed run (nextRun=${nextRunStr}, ${Math.round(staleMs / 1000)}s ago) - triggering catch-up within grace`
        );
        this.triggerCatchUpRun(task.id);
      } else {
        // Skip the missed run and advance nextRun metadata.
        console.warn(
          `[TaskScheduler] Task ${task.id} (${task.name}) has stale nextRun=${nextRunStr} (${Math.round(staleMs / 1000)}s ago) - advancing metadata${
            graceMs === 0 ? " (grace disabled)" : " (outside grace)"
          }`
        );
        this.recomputeNextRun(task.id);
      }
    }
  }

  /**
   * Trigger a scheduled catch-up run asynchronously, guarded against
   * duplicate concurrent runs.
   */
  private triggerCatchUpRun(taskId: string): void {
    if (this.inflightTaskIds.has(taskId)) return;
    this.inflightTaskIds.add(taskId);

    this.taskRunner
      .runTask(taskId, "scheduled")
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[TaskScheduler] Catch-up run failed (${taskId}): ${message}`);
      })
      .finally(() => {
        this.inflightTaskIds.delete(taskId);
        this.recomputeNextRun(taskId);
      });
  }

  /**
   * Recompute and persist nextRun from the existing scheduled task
   * without destroying/recreating the cron timer.
   */
  private recomputeNextRun(taskId: string): void {
    const scheduledTask = this.scheduledTasks.get(taskId);
    if (!scheduledTask) {
      // No live timer — if the task is still enabled, re-register it
      // (which also sets nextRun). If deleted/disabled, nothing to do.
      try {
        const task = this.taskStore.getTask(taskId);
        if (task.enabled) {
          this.schedule(task);
        }
      } catch {
        // Task was deleted — nothing to recompute.
      }
      return;
    }
    const nextRun = scheduledTask.getNextRun();
    this.taskStore.updateRunTimes(taskId, {
      nextRun: nextRun ? nextRun.toISOString() : null,
    });
  }

  private schedule(task: TaskRecord): void {
    if (!this.options.enabled) return;

    // Create the new schedule BEFORE destroying the old one, so a
    // cron.schedule() failure cannot leave the task timerless.
    const scheduledTask = cron.schedule(
      task.cron,
      () => {
        // Advance nextRun metadata immediately at tick acceptance, before
        // the run settles, so a long/hung task cannot leave nextRun stale.
        this.advanceNextRunAfterTick(task.id);

        // Guard against overlap with watchdog-triggered catch-up runs.
        if (this.inflightTaskIds.has(task.id)) {
          console.warn(
            `[TaskScheduler] Cron tick for ${task.id} skipped - run already in progress`
          );
          return;
        }
        this.inflightTaskIds.add(task.id);

        // Return the promise so noOverlap can track in-progress execution.
        return this.taskRunner
          .runTask(task.id, "scheduled")
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[TaskScheduler] Task failed (${task.id}): ${message}`);
          })
          .finally(() => {
            this.inflightTaskIds.delete(task.id);
          });
      },
      {
        timezone: task.timezone,
        name: task.id,
        noOverlap: true,
      }
    );

    // Now safe to replace the old timer.
    this.unschedule(task.id);
    this.scheduledTasks.set(task.id, scheduledTask);

    const nextRun = scheduledTask.getNextRun();
    this.taskStore.updateRunTimes(task.id, {
      nextRun: nextRun ? nextRun.toISOString() : null,
    });
    console.log(
      `[TaskScheduler] Scheduled ${task.id} (${task.name}) next=${nextRun?.toISOString() ?? "none"}`
    );
  }

  /**
   * Advance nextRun after a cron tick fires. Uses setImmediate to ensure
   * node-cron has internally advanced past the firing moment, so
   * getNextRun() returns the true next occurrence rather than the one
   * that just fired.
   */
  private advanceNextRunAfterTick(taskId: string): void {
    setImmediate(() => {
      try {
        this.recomputeNextRun(taskId);
      } catch (error) {
        // Task may have been deleted between tick and advancement.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[TaskScheduler] Could not advance nextRun for ${taskId}: ${message}`);
      }
    });
  }

  private unschedule(taskId: string): void {
    const existing = this.scheduledTasks.get(taskId);
    if (!existing) return;
    existing.stop();
    existing.destroy();
    this.scheduledTasks.delete(taskId);
  }
}
