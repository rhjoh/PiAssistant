const API_BASE = 'http://localhost:3457';

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
  status: 'running' | 'completed' | 'failed' | 'skipped';
  resultSummary: string | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
}

export interface TaskInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  enabled?: boolean;
  variables?: Record<string, string>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listTasks(): Promise<TaskRecord[]> {
  const data = await request<{ tasks: TaskRecord[] }>('/api/tasks');
  return data.tasks ?? [];
}

export async function createTask(input: TaskInput): Promise<TaskRecord> {
  const data = await request<{ task: TaskRecord }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.task;
}

export async function updateTask(id: string, input: Partial<TaskInput>): Promise<TaskRecord> {
  const data = await request<{ task: TaskRecord }>(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return data.task;
}

export async function deleteTask(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' });
}

export async function listRuns(taskId: string, limit = 25): Promise<TaskRunRecord[]> {
  const data = await request<{ runs: TaskRunRecord[] }>(`/api/tasks/${taskId}/runs?limit=${limit}`);
  return data.runs ?? [];
}

export async function runTaskNow(taskId: string): Promise<TaskRunRecord> {
  const data = await request<{ run: TaskRunRecord }>(`/api/tasks/${taskId}/run`, {
    method: 'POST',
  });
  return data.run;
}
