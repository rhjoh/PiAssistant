import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PiRpcClient } from "./pi-rpc.js";

const NO_ACTION_MARKER = "[[NO_ACTION]]";

// Default: 15 minutes
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface HeartbeatOptions {
  intervalMs?: number;
  heartbeatFile?: string;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private heartbeatFile: string;

  constructor(
    private pi: PiRpcClient,
    private onResponse: (response: string) => void,
    private cwd: string,
    options: HeartbeatOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.heartbeatFile = options.heartbeatFile ?? "heartbeat.md";
  }

  start(): void {
    if (this.timer) {
      return;
    }

    console.log(`[Heartbeat] Starting with ${this.intervalMs / 60000} minute interval`);

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[Heartbeat] Stopped");
    }
  }

  private async tick(): Promise<void> {
    if (!this.pi.isRunning) {
      console.log("[Heartbeat] Skipping - Pi not running");
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleString("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    // Read heartbeat.md and inject current time
    let prompt: string;
    try {
      const filePath = resolve(this.cwd, this.heartbeatFile);
      const content = await readFile(filePath, "utf-8");
      prompt = `[Heartbeat]\n\n${content.replace("{{TIME}}", timeStr)}`;
    } catch (err) {
      console.error("[Heartbeat] Failed to read heartbeat.md:", err);
      return;
    }

    console.log(`[Heartbeat] Sending heartbeat at ${timeStr}`);

    try {
      const response = await this.pi.prompt(prompt);
      // Strip backticks - agent sometimes wraps the marker in code formatting
      const trimmed = response.trim().replace(/^`+|`+$/g, "");

      if (trimmed === NO_ACTION_MARKER || trimmed.includes(NO_ACTION_MARKER) || !trimmed) {
        console.log("[Heartbeat] No action needed");
        return;
      }

      console.log(`[Heartbeat] Agent responded: ${trimmed.slice(0, 100)}...`);
      this.onResponse(trimmed);
    } catch (err) {
      console.error("[Heartbeat] Error:", err);
    }
  }
}
