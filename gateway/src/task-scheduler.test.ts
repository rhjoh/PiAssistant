import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRunner } from "./task-runner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TaskStore } from "./task-store.js";

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
      cron: "0 6 * * *",
    });
    store.createTask({
      name: "Disabled",
      prompt: "Run",
      cron: "0 7 * * *",
      enabled: false,
    });

    scheduler = new TaskScheduler(
      store,
      { runTask: vi.fn() } as unknown as TaskRunner,
      { enabled: true }
    );
    scheduler.init();

    expect((scheduler as unknown as { scheduledTasks: Map<string, unknown> }).scheduledTasks.size).toBe(1);
    expect(store.getTask(enabled.id).nextRun).not.toBeNull();
  });

  it("refreshes task registrations after disabling", () => {
    const task = store.createTask({
      name: "Enabled",
      prompt: "Run",
      cron: "0 6 * * *",
    });
    scheduler = new TaskScheduler(
      store,
      { runTask: vi.fn() } as unknown as TaskRunner,
      { enabled: true }
    );
    scheduler.init();

    store.updateTask(task.id, { enabled: false });
    scheduler.refreshTask(task.id);

    expect((scheduler as unknown as { scheduledTasks: Map<string, unknown> }).scheduledTasks.size).toBe(0);
    expect(store.getTask(task.id).nextRun).toBeNull();
  });
});
