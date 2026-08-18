import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent } from "./types.js";

/** Minimal fake of a spawned `pi` child process. */
class FakePiProcess {
  exitCode: number | null = null;
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  private commands: unknown[] = [];
  private stdinBuffer = "";
  private exitHandlers: Array<(code: number | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString();
      while (true) {
        const newlineIndex = this.stdinBuffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = this.stdinBuffer.slice(0, newlineIndex).trim();
        this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
        if (line) this.commands.push(JSON.parse(line));
      }
    });
  }

  on(event: string, cb: (...args: never[]) => void): this {
    if (event === "exit") this.exitHandlers.push(cb as (code: number | null) => void);
    if (event === "error") this.errorHandlers.push(cb as (err: Error) => void);
    return this;
  }

  off(): this {
    return this;
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 1;
    for (const handler of this.exitHandlers) handler(this.exitCode);
    this.stdout.end();
    return true;
  }

  /** Simulate Pi writing a JSON event line to stdout. */
  emitLine(value: unknown): void {
    this.stdout.write(JSON.stringify(value) + "\n");
  }

  /** Commands the gateway has written to stdin so far. */
  capturedCommands(): unknown[] {
    return [...this.commands];
  }
}

function userMessageStart(text: string): PiEvent {
  return {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

function textDelta(delta: string): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function textDone(text: string): PiEvent {
  return { type: "message_update", assistantMessageEvent: { type: "text_done", text } };
}

async function startClient(proc: FakePiProcess): Promise<PiRpcClient> {
  const client = new PiRpcClient("/tmp/test-session.jsonl", "/tmp", {
    spawnImpl: (() => proc) as unknown as typeof import("node:child_process").spawn,
    startupGraceMs: 1,
  });
  await client.start();
  return client;
}

/** Wait until the gateway has written `count` commands to Pi's stdin. */
async function waitForCommandCount(proc: FakePiProcess, count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (proc.capturedCommands().length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} commands (got ${proc.capturedCommands().length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("PiRpcClient lifecycle", () => {
  it("sends thinking-level discovery and mutation RPC commands", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const levelsPromise = client.getAvailableThinkingLevels();
    await waitForCommandCount(proc, 1);
    const levelsCommand = proc.capturedCommands()[0] as { id: string; type: string };
    expect(levelsCommand.type).toBe("get_available_thinking_levels");
    proc.emitLine({
      type: "response",
      id: levelsCommand.id,
      command: "get_available_thinking_levels",
      success: true,
      data: { levels: ["off", "high", "max"] },
    });
    await expect(levelsPromise).resolves.toMatchObject({ success: true });

    const setPromise = client.setThinkingLevel("high");
    await waitForCommandCount(proc, 2);
    const setCommand = proc.capturedCommands()[1] as { id: string; type: string; level: string };
    expect(setCommand).toMatchObject({ type: "set_thinking_level", level: "high" });
    proc.emitLine({
      type: "response",
      id: setCommand.id,
      command: "set_thinking_level",
      success: true,
    });
    await expect(setPromise).resolves.toBeUndefined();
  });

  it("resolves runPrompt only at agent_settled, not agent_end", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    let settled = false;
    const promise = client.prompt("hello", { source: "user" }).then((text) => {
      settled = true;
      return text;
    });

    await waitForCommandCount(proc, 1);
    proc.emitLine({ type: "agent_start" });
    proc.emitLine(userMessageStart("hello"));
    proc.emitLine(textDelta("Hello "));
    proc.emitLine(textDelta("world"));
    proc.emitLine(textDone("Hello world"));
    proc.emitLine({ type: "agent_end", messages: [], willRetry: false });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(client.isPromptActive).toBe(true);

    proc.emitLine({ type: "agent_settled" });
    await expect(promise).resolves.toBe("Hello world");
    expect(settled).toBe(true);
    expect(client.isPromptActive).toBe(false);
  });

  it("resets accumulated text on agent_start for retry/continuation runs", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const promise = client.prompt("do it", { source: "user" });

    await waitForCommandCount(proc, 1);
    // First (failed) low-level run.
    proc.emitLine({ type: "agent_start" });
    proc.emitLine(textDelta("partial"));
    proc.emitLine({ type: "agent_end", messages: [], willRetry: true });

    // Retry run - accumulated text must not include the failed attempt.
    proc.emitLine({ type: "agent_start" });
    proc.emitLine(textDelta("retried response"));
    proc.emitLine(textDone("retried response"));
    proc.emitLine({ type: "agent_end", messages: [], willRetry: false });
    proc.emitLine({ type: "agent_settled" });

    await expect(promise).resolves.toBe("retried response");
  });

  it("resolves with partial text when a run is aborted", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const promise = client.prompt("long task", { source: "user" });

    await waitForCommandCount(proc, 1);
    proc.emitLine({ type: "agent_start" });
    proc.emitLine(textDelta("working on it"));
    client.abort();
    proc.emitLine({ type: "agent_end", messages: [], willRetry: false });
    proc.emitLine({ type: "agent_settled" });

    await expect(promise).resolves.toBe("working on it");
    expect(client.isPromptActive).toBe(false);
  });

  it("submitDuringRun sends streamingBehavior immediately and resolves on acceptance", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const responsePromise = client.submitDuringRun("Change direction", "steer", {
      source: "user",
      id: "turn-2",
    });

    await waitForCommandCount(proc, 1);
    const commands = proc.capturedCommands();
    expect(commands.length).toBe(1);
    expect(commands[0]).toMatchObject({
      type: "prompt",
      message: "Change direction",
      streamingBehavior: "steer",
    });
    const sentId = (commands[0] as { id: string }).id;

    proc.emitLine({ type: "response", id: sentId, command: "prompt", success: true });
    const response = await responsePromise;
    expect(response.success).toBe(true);
  });

  it("submitDuringRun rejects when Pi rejects the preflight", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const responsePromise = client.submitDuringRun("/extension-command", "steer", {
      source: "user",
      id: "turn-3",
    });

    await waitForCommandCount(proc, 1);
    const sentId = (proc.capturedCommands()[0] as { id: string }).id;
    proc.emitLine({
      type: "response",
      id: sentId,
      command: "prompt",
      success: false,
      error: "Extension command cannot be queued",
    });

    await expect(responsePromise).rejects.toThrow("Extension command cannot be queued");
  });

  it("does not enqueue submitDuringRun behind active prompt FIFO work", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const active = client.prompt("original", { source: "user" });
    await waitForCommandCount(proc, 1);
    proc.emitLine({ type: "agent_start" });

    const submitPromise = client.submitDuringRun("steer it", "steer", { id: "turn-steer" });
    await waitForCommandCount(proc, 2);

    // The steering submission must reach stdin immediately, even though the
    // original prompt has not settled.
    const commands = proc.capturedCommands();
    expect(commands.map((c) => (c as { message?: string }).message)).toContain("steer it");

    const submitCommand = commands.find((c) => (c as { message?: string }).message === "steer it") as { id: string };
    proc.emitLine({ type: "response", id: submitCommand.id, command: "prompt", success: true });
    await submitPromise;

    proc.emitLine({ type: "agent_end", messages: [], willRetry: false });
    proc.emitLine({ type: "agent_settled" });
    await active;
  });

  it("rejects the prompt when the process exits mid-run", async () => {
    const proc = new FakePiProcess();
    const client = await startClient(proc);

    const promise = client.prompt("doomed", { source: "user" });
    await waitForCommandCount(proc, 1);
    proc.emitLine({ type: "agent_start" });
    proc.kill();

    await expect(promise).rejects.toThrow(/exited/);
    expect(client.isPromptActive).toBe(false);
  });
});
