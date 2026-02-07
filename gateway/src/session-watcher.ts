console.log("[SessionWatcher] Module loaded");

import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export type TuiStatus = "active" | "none";

export interface TuiLock {
  pid: number;
  session: string;
  startedAt?: string;
}

/**
 * Detects TUI sessions via a lock file written by the `assistant` shell alias.
 * Polls the lock file and verifies the PID is still alive.
 */
export class SessionWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tuiActive = false;
  private listeners: Array<(event: { type: "tui-detected" | "tui-gone"; pid?: number }) => void> = [];
  private resolvedSessionPath: string;

  constructor(
    sessionPath: string,
    private lockPath: string,
    private pollIntervalMs = 5000,
  ) {
    this.resolvedSessionPath = resolve(sessionPath);
    console.log(`[SessionWatcher] Initialized — lock: ${this.lockPath}, session: ${this.resolvedSessionPath}`);
  }

  on(listener: (event: { type: "tui-detected" | "tui-gone"; pid?: number }) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.interval) return;
    console.log(`[SessionWatcher] Polling started (every ${this.pollIntervalMs / 1000}s)`);
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log("[SessionWatcher] Stopped");
    }
  }

  get isTuiActive(): boolean {
    return this.tuiActive;
  }

  async getActiveLock(): Promise<TuiLock | null> {
    try {
      const raw = await readFile(this.lockPath, "utf-8");
      const lock = JSON.parse(raw) as TuiLock;

      if (!lock.pid || !Number.isFinite(lock.pid)) return null;

      // Check session matches
      if (lock.session && resolve(lock.session) !== this.resolvedSessionPath) return null;

      // Check PID is alive
      if (!this.isPidAlive(lock.pid)) {
        console.log(`[SessionWatcher] Stale lock file (PID ${lock.pid} dead), removing`);
        await this.clearLock();
        return null;
      }

      return lock;
    } catch {
      return null;
    }
  }

  async checkStatus(): Promise<TuiStatus> {
    const lock = await this.getActiveLock();
    return lock ? "active" : "none";
  }

  async killTui(): Promise<{ killed: boolean; pid?: number }> {
    const lock = await this.getActiveLock();
    if (!lock) return { killed: false };

    try {
      process.kill(lock.pid, "SIGTERM");
      console.log(`[SessionWatcher] Killed TUI process (PID ${lock.pid})`);
      await this.clearLock();
      return { killed: true, pid: lock.pid };
    } catch (err) {
      console.warn(`[SessionWatcher] Failed to kill PID ${lock.pid}:`, err);
      await this.clearLock();
      return { killed: false, pid: lock.pid };
    }
  }

  async clearLock(): Promise<void> {
    try { await unlink(this.lockPath); } catch { /* ignore */ }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return e.code === "EPERM";
    }
  }

  private async poll(): Promise<void> {
    const lock = await this.getActiveLock();
    const wasActive = this.tuiActive;
    const isActive = lock !== null;

    if (isActive && !wasActive) {
      this.tuiActive = true;
      console.log(`[SessionWatcher] TUI detected — PID ${lock!.pid}, started ${lock!.startedAt ?? "unknown"}`);
      for (const listener of this.listeners) {
        listener({ type: "tui-detected", pid: lock!.pid });
      }
    } else if (!isActive && wasActive) {
      this.tuiActive = false;
      console.log("[SessionWatcher] TUI gone — lock file cleared or PID dead");
      for (const listener of this.listeners) {
        listener({ type: "tui-gone" });
      }
    }
  }
}
