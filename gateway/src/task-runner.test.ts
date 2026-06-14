import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastManager } from "./broadcast.js";
import { TaskRunner, renderTaskPrompt } from "./task-runner.js";
import { TaskStore, type TaskRecord } from "./task-store.js";

describe("renderTaskPrompt", () => {
  it("injects built-in and custom variables", () => {
    const task: TaskRecord = {
      id: "task_1",
      name: "Morning",
      prompt: "{{day_of_week}} {{date}} {{time}} {{topic}}",
      cron: "0 6 * * *",
      timezone: "Australia/Melbourne",
      enabled: true,
      variables: { topic: "AI" },
      lastRun: null,
      nextRun: null,
      createdAt: "",
      updatedAt: "",
    };

    const rendered = renderTaskPrompt(task, new Date("2026-06-14T20:00:00.000Z"));
    expect(rendered).toBe("Monday 2026-06-15 06:00 AI");
  });
});

describe("TaskRunner", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "task-runner-"));
    store = new TaskStore({
      dbPath: join(dir, "tasks.sqlite"),
      defaultTimezone: "Australia/Melbourne",
    });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("marks runs completed when the prompt succeeds", async () => {
    const task = store.createTask({
      name: "Morning",
      prompt: "Brief me",
      cron: "0 6 * * *",
    });
    const broadcastManager = {
      sendTaskPrompt: vi.fn().mockResolvedValue("All done"),
    } as unknown as BroadcastManager;

    const runner = new TaskRunner(store, broadcastManager);
    const run = await runner.runTask(task.id, "manual");

    expect(run.status).toBe("completed");
    expect(run.resultSummary).toBe("All done");
    expect(store.getTask(task.id).lastRun).toBe(run.finishedAt);
  });

  it("marks runs failed when the prompt fails", async () => {
    const task = store.createTask({
      name: "Morning",
      prompt: "Brief me",
      cron: "0 6 * * *",
    });
    const broadcastManager = {
      sendTaskPrompt: vi.fn().mockRejectedValue(new Error("Pi failed")),
    } as unknown as BroadcastManager;

    const runner = new TaskRunner(store, broadcastManager);
    await expect(runner.runTask(task.id, "manual")).rejects.toThrow("Pi failed");

    const [run] = store.listRuns(task.id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Pi failed");
    expect(store.getTask(task.id).lastRun).toBe(run.finishedAt);
  });
});
