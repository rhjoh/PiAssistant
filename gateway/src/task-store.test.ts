import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./task-store.js";

describe("TaskStore", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "task-store-"));
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

  it("creates the schema and persists task variables", () => {
    const task = store.createTask({
      name: "Morning",
      prompt: "Brief me on {{topic}}",
      cron: "0 6 * * *",
      variables: { topic: "AI" },
    });

    expect(task.enabled).toBe(true);
    expect(task.timezone).toBe("Australia/Melbourne");
    expect(task.variables).toEqual({ topic: "AI" });
    expect(store.getTask(task.id).prompt).toBe("Brief me on {{topic}}");
  });

  it("rejects invalid cron expressions", () => {
    expect(() =>
      store.createTask({
        name: "Bad",
        prompt: "Run",
        cron: "not a cron",
      })
    ).toThrow(/Invalid cron expression/);
  });

  it("records completed and failed task runs", () => {
    const task = store.createTask({
      name: "Morning",
      prompt: "Brief me",
      cron: "0 6 * * *",
    });

    const completed = store.createRun({
      taskId: task.id,
      renderedPrompt: "Brief me",
      trigger: "manual",
    });
    store.completeRun(completed.id, "Done");

    const failed = store.createRun({
      taskId: task.id,
      renderedPrompt: "Brief me",
      trigger: "scheduled",
    });
    store.failRun(failed.id, "Nope");

    const runs = store.listRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.status === "failed")?.error).toBe("Nope");
    expect(runs.find((run) => run.status === "completed")?.resultSummary).toBe("Done");
  });
});
