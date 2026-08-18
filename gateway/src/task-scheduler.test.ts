import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRunner } from "./task-runner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TaskStore } from "./task-store.js";

// cron expression with a far-future, stable nextRun so scheduling doesn't
// leave nextRun in the past by the time assertions run.
const FUTURE_CRON = "0 0 1 1 *"; // 00:00 on Jan 1st each year

function makeRunnerMock(): { runner: TaskRunner; runTask: ReturnType<typeof vi.fn> } {
  const runTask = vi.fn().mockResolvedValue({ id: "run_test", status: "completed" });
  const runner = { runTask } as unknown as TaskRunner;
  return { runner, runTask };
}

describe("TaskScheduler", () => {
  let dir: string;
  let store: TaskStore;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "task-scheduler-"));
    store = new TaskStore({
      dbPath: join(dir, "tasks.sqlite"),
      defaultTimezone: "Australia/Melbourne",
    });
    await store.init();
  });

  afterEach(async () => {
    scheduler?.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("rehydrates enabled tasks and skips disabled tasks", () => {
    const enabled = store.createTask({
      name: "Enabled",
      prompt: "Run",
      cron: FUTURE_CRON,
    });
    store.createTask({
      name: "Disabled",
      prompt: "Run",
      cron: FUTURE_CRON,
      enabled: false,
    });

    const { runner } = makeRunnerMock();
    scheduler = new TaskScheduler(store, runner, { enabled: true });
    scheduler.init();

    expect(
      (scheduler as unknown as { scheduledTasks: Map<string, unknown> }).scheduledTasks.size
    ).toBe(1);
    expect(store.getTask(enabled.id).nextRun).not.toBeNull();
  });

  it("refreshes task registrations after disabling", () => {
    const task = store.createTask({
      name: "Enabled",
      prompt: "Run",
      cron: FUTURE_CRON,
    });
    const { runner } = makeRunnerMock();
    scheduler = new TaskScheduler(store, runner, { enabled: true });
    scheduler.init();

    store.updateTask(task.id, { enabled: false });
    scheduler.refreshTask(task.id);

    expect(
      (scheduler as unknown as { scheduledTasks: Map<string, unknown> }).scheduledTasks.size
    ).toBe(0);
    expect(store.getTask(task.id).nextRun).toBeNull();
  });

  it("manual run does not destroy/recreate the cron registration unnecessarily", async () => {
    const task = store.createTask({
      name: "Manual",
      prompt: "Run",
      cron: FUTURE_CRON,
    });
    const { runner } = makeRunnerMock();
    scheduler = new TaskScheduler(store, runner, { enabled: true });
    scheduler.init();

    const tasksMap = scheduler as unknown as {
      scheduledTasks: Map<string, { stop: () => void; destroy: () => void }>;
    };
    const original = tasksMap.scheduledTasks.get(task.id)!;
    const stopSpy = vi.spyOn(original, "stop");
    const destroySpy = vi.spyOn(original, "destroy");

    await scheduler.runNow(task.id);

    // Same handle instance preserved — not destroyed and recreated.
    expect(tasksMap.scheduledTasks.get(task.id)).toBe(original);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it("startup advances stale nextRun when grace is zero", () => {
    const task = store.createTask({
      name: "Stale",
      prompt: "Run",
      cron: FUTURE_CRON,
    });

    const { runner, runTask } = makeRunnerMock();
    scheduler = new TaskScheduler(store, runner, { enabled: true, missedRunGraceMs: 0 });

    // Force nextRun into the past via the store, then init.
    const staleIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    store.updateRunTimes(task.id, { nextRun: staleIso });

    scheduler.init();

    expect(runTask).not.toHaveBeenCalled();
    const refreshed = store.getTask(task.id);
    expect(Date.parse(refreshed.nextRun!)).toBeGreaterThan(Date.now());
  });

  it("startup triggers one missed run within grace", () => {
    const task = store.createTask({
      name: "Missed",
      prompt: "Run",
      cron: FUTURE_CRON,
    });

    const { runner, runTask } = makeRunnerMock();
    // generous grace so the stale timestamp qualifies
    scheduler = new TaskScheduler(store, runner, {
      enabled: true,
      missedRunGraceMs: 24 * 60 * 60 * 1000,
    });

    const staleIso = new Date(Date.now() - 60 * 1000).toISOString();
    store.updateRunTimes(task.id, { nextRun: staleIso });

    scheduler.init();

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(task.id, "scheduled");
  });

  it("reconcile re-registers enabled tasks missing a live cron handle", () => {
    const task = store.createTask({
      name: "Orphaned",
      prompt: "Run",
      cron: FUTURE_CRON,
    });
    const { runner } = makeRunnerMock();
    scheduler = new TaskScheduler(store, runner, { enabled: true });

    // Skip init() so nothing is registered; nextRun is future so reconcile
    // shouldn't trigger a catch-up — only re-registration.
    const scheduledTask = (scheduler as unknown as { scheduledTasks: Map<string, unknown> }).scheduledTasks;
    expect(scheduledTask.size).toBe(0);

    scheduler.reconcileStaleTasks();

    expect(scheduledTask.size).toBe(1);
    expect(store.getTask(task.id).nextRun).not.toBeNull();
  });

  it("watchdog advances stale nextRun after init", () => {
    vi.useFakeTimers();
    try {
      const task = store.createTask({
        name: "Watchdog stale",
        prompt: "Run",
        cron: FUTURE_CRON,
      });
      const { runner, runTask } = makeRunnerMock();
      scheduler = new TaskScheduler(store, runner, {
        enabled: true,
        missedRunGraceMs: 0,
        watchdogIntervalMs: 1000,
      });
      scheduler.init();

      store.updateRunTimes(task.id, {
        nextRun: new Date(Date.now() - 60 * 1000).toISOString(),
      });

      vi.advanceTimersByTime(1000);

      expect(runTask).not.toHaveBeenCalled();
      expect(Date.parse(store.getTask(task.id).nextRun!)).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});
