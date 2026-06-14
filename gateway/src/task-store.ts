import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import cron from "node-cron";

export type TaskRunStatus = "running" | "completed" | "failed" | "skipped";
export type TaskRunTrigger = "scheduled" | "manual";

export interface TaskRecord {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  variables: Record<string, string>;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRunRecord {
  id: string;
  taskId: string;
  renderedPrompt: string;
  startedAt: string;
  finishedAt: string | null;
  status: TaskRunStatus;
  resultSummary: string | null;
  error: string | null;
  trigger: TaskRunTrigger;
}

export interface CreateTaskInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
  variables?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  variables?: Record<string, unknown>;
}

type TaskRow = {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: 0 | 1;
  variables_json: string;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRunRow = {
  id: string;
  task_id: string;
  rendered_prompt: string;
  started_at: string;
  finished_at: string | null;
  status: TaskRunStatus;
  result_summary: string | null;
  error: string | null;
  trigger: TaskRunTrigger;
};

export class TaskStore {
  private db: Database.Database | null = null;

  constructor(
    private options: {
      dbPath: string;
      defaultTimezone: string;
    }
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.options.dbPath), { recursive: true });
    const db = new Database(this.options.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    this.db = db;
    this.migrate();
    this.reconcileStuckRuns();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Mark any 'running' task runs as 'failed' on startup.
   * These are left over from a gateway crash during task execution.
   */
  private reconcileStuckRuns(): void {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE task_runs
      SET status = 'failed', finished_at = ?, error = 'Gateway restarted while task was running'
      WHERE status = 'running'
    `).run(now);
    if (result.changes > 0) {
      console.log(`[TaskStore] Reconciled ${result.changes} stuck running task run(s) on startup`);
    }
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const task = normalizeTaskInput(input, this.options.defaultTimezone);
    const id = createId("task");

    db.prepare(`
      INSERT INTO tasks (
        id, name, prompt, cron, timezone, enabled, variables_json,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      task.name,
      task.prompt,
      task.cron,
      task.timezone,
      task.enabled ? 1 : 0,
      JSON.stringify(task.variables),
      now,
      now
    );

    return this.getTask(id);
  }

  updateTask(id: string, input: UpdateTaskInput): TaskRecord {
    const current = this.getTask(id);
    const merged = normalizeTaskInput(
      {
        name: input.name ?? current.name,
        prompt: input.prompt ?? current.prompt,
        cron: input.cron ?? current.cron,
        timezone: input.timezone ?? current.timezone,
        enabled: input.enabled ?? current.enabled,
        variables: input.variables ?? current.variables,
      },
      this.options.defaultTimezone
    );

    this.requireDb()
      .prepare(`
        UPDATE tasks
        SET name = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?,
            variables_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        merged.name,
        merged.prompt,
        merged.cron,
        merged.timezone,
        merged.enabled ? 1 : 0,
        JSON.stringify(merged.variables),
        new Date().toISOString(),
        id
      );

    return this.getTask(id);
  }

  deleteTask(id: string): void {
    const result = this.requireDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw new Error(`Task not found: ${id}`);
    }
  }

  getTask(id: string): TaskRecord {
    const row = this.requireDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) {
      throw new Error(`Task not found: ${id}`);
    }
    return mapTask(row);
  }

  listTasks(): TaskRecord[] {
    const rows = this.requireDb()
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC")
      .all() as TaskRow[];
    return rows.map(mapTask);
  }

  listEnabledTasks(): TaskRecord[] {
    const rows = this.requireDb()
      .prepare("SELECT * FROM tasks WHERE enabled = 1 ORDER BY created_at ASC")
      .all() as TaskRow[];
    return rows.map(mapTask);
  }

  updateRunTimes(id: string, values: { lastRun?: string | null; nextRun?: string | null }): void {
    const current = this.getTask(id);
    this.requireDb()
      .prepare("UPDATE tasks SET last_run = ?, next_run = ?, updated_at = ? WHERE id = ?")
      .run(
        values.lastRun !== undefined ? values.lastRun : current.lastRun,
        values.nextRun !== undefined ? values.nextRun : current.nextRun,
        new Date().toISOString(),
        id
      );
  }

  createRun(input: {
    taskId: string;
    renderedPrompt: string;
    trigger: TaskRunTrigger;
  }): TaskRunRecord {
    const now = new Date().toISOString();
    const id = createId("run");
    this.requireDb()
      .prepare(`
        INSERT INTO task_runs (
          id, task_id, rendered_prompt, started_at, status, trigger
        )
        VALUES (?, ?, ?, ?, 'running', ?)
      `)
      .run(id, input.taskId, input.renderedPrompt, now, input.trigger);
    return this.getRun(id);
  }

  completeRun(id: string, resultSummary: string): TaskRunRecord {
    this.requireDb()
      .prepare(`
        UPDATE task_runs
        SET status = 'completed', finished_at = ?, result_summary = ?, error = NULL
        WHERE id = ?
      `)
      .run(new Date().toISOString(), resultSummary.slice(0, 1000), id);
    return this.getRun(id);
  }

  failRun(id: string, error: string): TaskRunRecord {
    this.requireDb()
      .prepare(`
        UPDATE task_runs
        SET status = 'failed', finished_at = ?, error = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), error.slice(0, 1000), id);
    return this.getRun(id);
  }

  getRun(id: string): TaskRunRecord {
    const row = this.requireDb().prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as
      | TaskRunRow
      | undefined;
    if (!row) {
      throw new Error(`Task run not found: ${id}`);
    }
    return mapRun(row);
  }

  listRuns(taskId: string, limit = 25): TaskRunRecord[] {
    this.getTask(taskId);
    const rows = this.requireDb()
      .prepare(`
        SELECT * FROM task_runs
        WHERE task_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      `)
      .all(taskId, Math.max(1, Math.min(limit, 100))) as TaskRunRow[];
    return rows.map(mapRun);
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        prompt         TEXT NOT NULL,
        cron           TEXT NOT NULL,
        timezone       TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        variables_json TEXT NOT NULL DEFAULT '{}',
        last_run       TEXT,
        next_run       TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        rendered_prompt TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        status          TEXT NOT NULL DEFAULT 'running',
        result_summary  TEXT,
        error           TEXT,
        trigger         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id_started_at
        ON task_runs(task_id, started_at DESC, id DESC);
    `);
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error("TaskStore not initialized");
    }
    return this.db;
  }
}

export function validateCronExpression(expression: string): void {
  if (!cron.validate(expression)) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
}

function normalizeTaskInput(
  input: CreateTaskInput,
  defaultTimezone: string
): Required<CreateTaskInput> {
  const name = cleanRequired(input.name, "name");
  const prompt = cleanRequired(input.prompt, "prompt");
  const cronExpression = cleanRequired(input.cron, "cron");
  validateCronExpression(cronExpression);

  return {
    name,
    prompt,
    cron: cronExpression,
    timezone: cleanOptional(input.timezone) ?? defaultTimezone,
    enabled: input.enabled ?? true,
    variables: normalizeVariables(input.variables),
  };
}

function cleanRequired(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function cleanOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeVariables(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("variables must be an object");
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const cleanKey = key.trim();
    if (!/^[a-zA-Z0-9_]+$/.test(cleanKey)) {
      throw new Error(`Invalid variable name: ${key}`);
    }
    normalized[cleanKey] = String(rawValue);
  }
  return normalized;
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    variables: parseVariables(row.variables_json),
    lastRun: row.last_run,
    nextRun: row.next_run,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    renderedPrompt: row.rendered_prompt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    resultSummary: row.result_summary,
    error: row.error,
    trigger: row.trigger,
  };
}

function parseVariables(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeVariables(parsed);
  } catch {
    return {};
  }
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
