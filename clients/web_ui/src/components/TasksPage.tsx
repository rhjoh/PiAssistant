import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listRuns,
  runTaskNow,
  type TaskRecord,
  type TaskRunRecord,
} from '@/lib/api';

const TIMEZONES = [
  'Australia/Melbourne',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Pacific/Auckland',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];

const DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type CronPreset = 'daily' | 'weekly' | 'hourly' | 'monthly' | 'custom';

interface TaskFormState {
  name: string;
  prompt: string;
  timezone: string;
  enabled: boolean;
  preset: CronPreset;
  time: string;
  days: number[];
  minute: number;
  monthDay: number;
  customCron: string;
  variables: { key: string; value: string }[];
}

const DEFAULT_FORM: TaskFormState = {
  name: '',
  prompt: '',
  timezone: 'Australia/Melbourne',
  enabled: true,
  preset: 'daily',
  time: '08:00',
  days: [1, 2, 3, 4, 5],
  minute: 0,
  monthDay: 1,
  customCron: '',
  variables: [],
};

function pad(n: number | string): string {
  return String(n).padStart(2, '0');
}

function buildCron(form: TaskFormState): string {
  switch (form.preset) {
    case 'daily': {
      const [h, m] = form.time.split(':').map(Number);
      return `${m ?? 0} ${h ?? 0} * * *`;
    }
    case 'weekly': {
      const [h, m] = form.time.split(':').map(Number);
      const days = form.days.length ? [...form.days].sort().join(',') : '*';
      return `${m ?? 0} ${h ?? 0} * * ${days}`;
    }
    case 'monthly': {
      const [h, m] = form.time.split(':').map(Number);
      return `${m ?? 0} ${h ?? 0} ${form.monthDay || 1} * *`;
    }
    case 'hourly':
      return `${form.minute} * * * *`;
    case 'custom':
      return form.customCron.trim();
  }
}

function cronToForm(cron: string): TaskFormState {
  const base: TaskFormState = { ...DEFAULT_FORM, variables: [] };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ...base, preset: 'custom', customCron: cron };
  }
  const [min, hour, dom, mon, dow] = parts;
  const minute = parseInt(min, 10);
  const h = parseInt(hour, 10);

  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return { ...base, preset: 'daily', time: `${pad(h)}:${pad(minute)}` };
  }
  if (dom === '*' && mon === '*' && dow !== '*' && hour !== '*' && min !== '*') {
    const days = dow
      .split(',')
      .map((s) => parseInt(s, 10) % 7)
      .filter((n) => !isNaN(n));
    return { ...base, preset: 'weekly', time: `${pad(h)}:${pad(minute)}`, days };
  }
  if (dom !== '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return { ...base, preset: 'monthly', time: `${pad(h)}:${pad(minute)}`, monthDay: parseInt(dom, 10) || 1 };
  }
  if (hour === '*' && min !== '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...base, preset: 'hourly', minute };
  }
  return { ...base, preset: 'custom', customCron: cron };
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const minute = parseInt(min, 10);
  const h = parseInt(hour, 10);

  let time: string;
  if (hour === '*' && min === '*') time = 'every minute';
  else if (hour === '*') time = `at minute ${minute} of every hour`;
  else if (min === '*') time = `every minute of hour ${pad(h)}`;
  else time = `${pad(h)}:${pad(minute)}`;

  if (dom === '*' && mon === '*' && dow === '*') return `Daily at ${time}`;
  if (dom === '*' && mon === '*' && dow !== '*') {
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    const days = dow
      .split(',')
      .map((s) => parseInt(s, 10) % 7)
      .filter((n) => !isNaN(n))
      .sort()
      .map((d) => DAY_NAMES[d])
      .join(', ');
    return `${days} at ${time}`;
  }
  if (dom !== '*' && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${time}`;
  if (dom === '*' && mon !== '*' && dow === '*') return `Every month ${mon} at ${time}`;
  return cron;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function isValidCron(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^(\d{1,2}|[*/,-]+|\d{1,2}[*/,-]+)+$/.test(p));
}

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-primary)',
  marginBottom: '6px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  fontSize: '13px',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-primary)',
  outline: 'none',
};

function TaskFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: TaskRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<TaskFormState>(() => {
    if (!initial) return DEFAULT_FORM;
    return {
      ...cronToForm(initial.cron),
      name: initial.name,
      prompt: initial.prompt,
      timezone: initial.timezone,
      enabled: initial.enabled,
      variables: Object.entries(initial.variables ?? {}).map(([key, value]) => ({ key, value })),
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronPreview = useMemo(() => buildCron(form), [form]);
  const cronValid = useMemo(() => isValidCron(cronPreview), [cronPreview]);

  const set = <K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setVariable = (index: number, patch: Partial<{ key: string; value: string }>) =>
    setForm((prev) => ({
      ...prev,
      variables: prev.variables.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    }));

  const toggleDay = (day: number) =>
    setForm((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((d) => d !== day) : [...prev.days, day],
    }));

  const handleSubmit = async () => {
    setError(null);
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    if (!form.prompt.trim()) {
      setError('Prompt is required');
      return;
    }
    if (!cronValid) {
      setError('Invalid cron expression. Expected 5 fields (e.g. 30 8 * * 1-5)');
      return;
    }

    const variables: Record<string, string> = {};
    for (const v of form.variables) {
      if (v.key.trim()) variables[v.key.trim()] = v.value;
    }

    const input = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cron: cronPreview,
      timezone: form.timezone,
      enabled: form.enabled,
      variables,
    };

    setSaving(true);
    try {
      if (initial) {
        await updateTask(initial.id, input);
      } else {
        await createTask(input);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const presetButton = (preset: CronPreset, label: string) => (
    <button
      type="button"
      onClick={() => set('preset', preset)}
      style={{
        flex: 1,
        padding: '6px 0',
        fontSize: '12px',
        fontFamily: 'var(--font-primary)',
        color: form.preset === preset ? 'var(--accent-primary)' : 'var(--text-secondary)',
        background: form.preset === preset ? 'var(--accent-primary-dim)' : 'transparent',
        border: `1px solid ${form.preset === preset ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '580px',
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-primary)' }}>
            {initial ? 'Edit Task' : 'New Task'}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>

        <div>
          <div style={labelStyle}>Name</div>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Morning briefing"
            style={inputStyle}
          />
        </div>

        <div>
          <div style={labelStyle}>Prompt</div>
          <textarea
            value={form.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            placeholder="Search for news about {{topic}} and give me a briefing."
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', minHeight: '64px' }}
          />
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', fontFamily: 'var(--font-primary)' }}>
            Instructions for the assistant. Supports {'{{variable}}'} substitution.
          </div>
        </div>

        <div>
          <div style={labelStyle}>Repeat</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {presetButton('daily', 'Daily')}
            {presetButton('weekly', 'Weekly')}
            {presetButton('hourly', 'Hourly')}
            {presetButton('monthly', 'Monthly')}
            {presetButton('custom', 'Custom')}
          </div>
        </div>

        {form.preset === 'daily' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>At</span>
            <input
              type="time"
              value={form.time}
              onChange={(e) => set('time', e.target.value)}
              style={{ ...inputStyle, width: '130px' }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)' }}>
              every day
            </span>
          </div>
        )}

        {form.preset === 'weekly' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>At</span>
              <input
                type="time"
                value={form.time}
                onChange={(e) => set('time', e.target.value)}
                style={{ ...inputStyle, width: '130px' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {DAY_OPTIONS.map((d) => {
                const active = form.days.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => toggleDay(d.value)}
                    style={{
                      flex: 1,
                      padding: '6px 0',
                      fontSize: '11px',
                      fontFamily: 'var(--font-primary)',
                      color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                      background: active ? 'var(--accent-primary-dim)' : 'transparent',
                      border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                    }}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {form.preset === 'hourly' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>At minute</span>
            <input
              type="number"
              min={0}
              max={59}
              value={form.minute}
              onChange={(e) => set('minute', Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
              style={{ ...inputStyle, width: '80px' }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)' }}>of every hour</span>
          </div>
        )}

        {form.preset === 'monthly' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>Day</span>
            <input
              type="number"
              min={1}
              max={31}
              value={form.monthDay}
              onChange={(e) => set('monthDay', Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
              style={{ ...inputStyle, width: '80px' }}
            />
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>at</span>
            <input
              type="time"
              value={form.time}
              onChange={(e) => set('time', e.target.value)}
              style={{ ...inputStyle, width: '130px' }}
            />
          </div>
        )}

        {form.preset === 'custom' && (
          <div>
            <input
              type="text"
              value={form.customCron}
              onChange={(e) => set('customCron', e.target.value)}
              placeholder="30 8 * * 1-5"
              style={inputStyle}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', fontFamily: 'var(--font-primary)' }}>
              Five fields: minute hour day-of-month month day-of-week
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Clock size={14} color="var(--text-muted)" />
          <span style={{ fontSize: '12px', color: cronValid ? 'var(--text-secondary)' : 'var(--accent-danger)', fontFamily: 'var(--font-primary)' }}>
            {cronPreview || '(empty schedule)'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '14px' }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Timezone</div>
            <select
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              style={inputStyle}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', paddingBottom: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
                style={{ accentColor: 'var(--accent-primary)' }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontFamily: 'var(--font-primary)' }}>Enabled</span>
            </label>
          </div>
        </div>

        <div>
          <div style={labelStyle}>Variables</div>
          {form.variables.length === 0 && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px', fontFamily: 'var(--font-primary)' }}>
              No variables. Use them in the prompt as {'{{name}}'}.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {form.variables.map((v, i) => (
              <div key={i} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="text"
                  value={v.key}
                  onChange={(e) => setVariable(i, { key: e.target.value })}
                  placeholder="name"
                  style={{ ...inputStyle, width: '180px' }}
                />
                <input
                  type="text"
                  value={v.value}
                  onChange={(e) => setVariable(i, { value: e.target.value })}
                  placeholder="value"
                  style={inputStyle}
                />
                <button
                  type="button"
                  onClick={() => set('variables', form.variables.filter((_, idx) => idx !== i))}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
                  title="Remove variable"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => set('variables', [...form.variables, { key: '', value: '' }])}
            style={{
              marginTop: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'transparent',
              border: '1px dashed var(--border-color-strong)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 12px',
              fontSize: '12px',
              color: 'var(--accent-primary)',
              fontFamily: 'var(--font-primary)',
              cursor: 'pointer',
            }}
          >
            <Plus size={12} /> Add variable
          </button>
        </div>

        {error && (
          <div style={{ fontSize: '12px', color: 'var(--accent-danger)', fontFamily: 'var(--font-primary)' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              fontFamily: 'var(--font-primary)',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              fontFamily: 'var(--font-primary)',
              color: 'var(--text-inverse)',
              background: 'var(--accent-primary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: saving ? 'wait' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : initial ? 'Save Changes' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskRuns({ taskId }: { taskId: string }) {
  const [runs, setRuns] = useState<TaskRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRuns(taskId, 20)
      .then((data) => {
        if (!cancelled) setRuns(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (error) {
    return <div style={{ fontSize: '12px', color: 'var(--accent-danger)', fontFamily: 'var(--font-primary)' }}>{error}</div>;
  }
  if (!runs) {
    return <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)' }}>Loading runs...</div>;
  }
  if (runs.length === 0) {
    return <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)' }}>No runs yet.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {runs.map((run) => {
        const statusColor =
          run.status === 'completed' ? 'var(--accent-success)' :
          run.status === 'failed' ? 'var(--accent-danger)' :
          run.status === 'running' ? 'var(--accent-info)' : 'var(--text-muted)';
        return (
          <div
            key={run.id}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '12px',
              fontSize: '12px',
              fontFamily: 'var(--font-primary)',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span style={{ color: statusColor, width: '70px', flexShrink: 0 }}>
              {run.status}
            </span>
            <span style={{ width: '46px', flexShrink: 0, color: 'var(--text-muted)' }}>
              {run.trigger}
            </span>
            <span style={{ width: '130px', flexShrink: 0, color: 'var(--text-muted)' }}>
              {formatDateTime(run.startedAt)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={run.error ?? run.resultSummary ?? ''}>
              {run.error ?? run.resultSummary ?? ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TaskRecord | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setTasks(await listTasks());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => refresh(true), 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  };

  const handleSaved = async () => {
    setModalOpen(false);
    setEditing(null);
    await refresh(true);
    showNotice(editing ? 'Task updated' : 'Task created');
  };

  const handleToggleEnabled = async (task: TaskRecord) => {
    try {
      await updateTask(task.id, { enabled: !task.enabled });
      await refresh(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunNow = async (task: TaskRecord) => {
    setRunningId(task.id);
    try {
      const run = await runTaskNow(task.id);
      showNotice(`Task run ${run.status}`);
      await refresh(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningId(null);
    }
  };

  const handleDelete = async (task: TaskRecord) => {
    try {
      await deleteTask(task.id);
      setConfirmDeleteId(null);
      if (expandedId === task.id) setExpandedId(null);
      await refresh(true);
      showNotice('Task deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto" style={{ background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: '860px', margin: '0 auto', padding: '24px 28px 48px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-primary)' }}>
              Tasks
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)', marginTop: '2px' }}>
              {tasks.filter((t) => t.enabled).length} of {tasks.length} enabled
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              fontSize: '13px',
              fontFamily: 'var(--font-primary)',
              color: 'var(--text-inverse)',
              background: 'var(--accent-primary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} /> New Task
          </button>
        </div>

        {notice && (
          <div style={{ fontSize: '12px', color: 'var(--accent-success)', fontFamily: 'var(--font-primary)' }}>
            {notice}
          </div>
        )}
        {error && (
          <div style={{ fontSize: '12px', color: 'var(--accent-danger)', fontFamily: 'var(--font-primary)' }}>
            {error}
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)', padding: '40px 0', textAlign: 'center' }}>
            Loading tasks...
          </div>
        ) : tasks.length === 0 ? (
          <div
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              border: '1px dashed var(--border-color-strong)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)' }}>
              No scheduled tasks yet
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)', marginTop: '8px', marginBottom: '16px' }}>
              Create a task to have the assistant run a prompt on a schedule.
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              style={{
                padding: '8px 14px',
                fontSize: '13px',
                fontFamily: 'var(--font-primary)',
                color: 'var(--accent-primary)',
                background: 'transparent',
                border: '1px solid var(--accent-primary)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              + Create your first task
            </button>
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '16px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-primary)' }}>
                  {task.name}
                </span>
                <button
                  type="button"
                  onClick={() => handleToggleEnabled(task)}
                  title={task.enabled ? 'Disable task' : 'Enable task'}
                  style={{
                    fontSize: '10px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontFamily: 'var(--font-primary)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    color: task.enabled ? 'var(--accent-success)' : 'var(--text-muted)',
                    background: task.enabled ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-input)',
                    border: `1px solid ${task.enabled ? 'rgba(34, 197, 94, 0.3)' : 'var(--border-color)'}`,
                    cursor: 'pointer',
                  }}
                >
                  {task.enabled ? 'enabled' : 'disabled'}
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                  title="Run history"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '5px 8px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-primary)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {expandedId === task.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Runs
                </button>
                <button
                  type="button"
                  onClick={() => handleRunNow(task)}
                  disabled={runningId === task.id}
                  title="Run now"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '5px 8px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-primary)',
                    color: runningId === task.id ? 'var(--accent-info)' : 'var(--accent-primary)',
                    cursor: runningId === task.id ? 'wait' : 'pointer',
                  }}
                >
                  <Play size={12} />
                  {runningId === task.id ? 'Running...' : 'Run now'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(task);
                    setModalOpen(true);
                  }}
                  title="Edit task"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '28px',
                    height: '28px',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(task.id)}
                  title="Delete task"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '28px',
                    height: '28px',
                    background: 'transparent',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--accent-danger)',
                    cursor: 'pointer',
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'var(--font-primary)', lineHeight: 1.5 }}>
                {task.prompt}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '10px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-primary)',
                  color: 'var(--text-muted)',
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '10px',
                }}
              >
                <div>
                  <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>
                    Schedule
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {describeCron(task.cron)} <span style={{ color: 'var(--text-muted)' }}>({task.cron})</span>
                  </span>
                </div>
                <div>
                  <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>
                    Timezone
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{task.timezone}</span>
                </div>
                <div>
                  <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>
                    Next run
                  </span>
                  <span style={{ color: task.nextRun ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                    {formatDateTime(task.nextRun)}
                  </span>
                </div>
                <div>
                  <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>
                    Last run
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{formatDateTime(task.lastRun)}</span>
                </div>
              </div>

              {expandedId === task.id && (
                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
                  <TaskRuns taskId={task.id} />
                </div>
              )}

              {confirmDeleteId === task.id && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '12px',
                    fontFamily: 'var(--font-primary)',
                    color: 'var(--text-secondary)',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--accent-danger)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '8px 12px',
                  }}
                >
                  <span>Delete "{task.name}"? This cannot be undone.</span>
                  <div style={{ flex: 1 }} />
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 10px',
                      fontSize: '12px',
                      fontFamily: 'var(--font-primary)',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(task)}
                    style={{
                      background: 'var(--accent-danger)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 10px',
                      fontSize: '12px',
                      fontFamily: 'var(--font-primary)',
                      color: 'var(--text-inverse)',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))
        )}

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <RefreshCw size={11} />
          Auto-refreshes every 30s. Task responses stream into the chat.
        </div>
      </div>

      {modalOpen && (
        <TaskFormModal
          initial={editing}
          onClose={() => {
            setModalOpen(false);
            setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
