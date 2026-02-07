import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { EventEmitter } from "node:events";
import type { PiCommand, PiEvent, PiResponse, PiState } from "./types.js";

export interface PiRpcEvents {
  event: [PiEvent];
  response: [PiResponse];
  text: [string]; // Convenience: accumulated text from text_delta events
  toolResult: [string, unknown]; // [toolName, result] - emitted on tool_execution_end
  error: [Error];
  exit: [number | null];
  ready: [];
}

export class PiRpcClient extends EventEmitter<PiRpcEvents> {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private currentText = "";
  private requestId = 0;

  constructor(
    private sessionPath: string,
    private cwd: string
  ) {
    super();
  }

  get currentTextLength(): number {
    return this.currentText.length;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async reload(): Promise<void> {
    console.log("[PiRpc] Reloading...");
    this.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.start();
    console.log("[PiRpc] Reload complete");
  }

  async switchSession(sessionPath: string): Promise<PiResponse> {
    return this.sendAndWait({ type: "switch_session", sessionPath });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // IMPORTANT: Don't pass --provider/--model to Pi
    // Let Pi restore model from session's model_change entry
    // We'll send set_model via RPC after Pi is ready if needed
    const args = ["--mode", "rpc", "--session", this.sessionPath];

    this.process = spawn("pi", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on("line", (line) => this.handleLine(line));

    this.process.stderr?.on("data", (data) => {
      console.error("[Pi stderr]", data.toString());
    });

    this.process.on("exit", (code) => {
      this.process = null;
      this.readline = null;
      this.emit("exit", code);
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    // Give Pi a moment to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.emit("ready");
  }

  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
      this.readline = null;
    }
  }

  async prompt(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning) {
        reject(new Error("Pi RPC not running"));
        return;
      }

      const id = `req-${++this.requestId}`;
      this.currentText = "";

      const cleanup = () => {
        this.off("event", onEvent);
        this.off("error", onError);
      };

      const onEvent = (event: PiEvent) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            this.currentText += event.assistantMessageEvent.delta;
            this.emit("text", this.currentText);
          }
        } else if (event.type === "agent_end") {
          cleanup();
          resolve(this.currentText);
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      this.on("event", onEvent);
      this.on("error", onError);

      this.send({ type: "prompt", message, id });
    });
  }

  async getState(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_state" });
  }

  async getAvailableModels(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_available_models" });
  }

  /**
   * Send set_model RPC command to change the model.
   * This writes a model_change entry to the session, so it persists.
   */
  async setModelViaRpc(provider: string, modelId: string): Promise<void> {
    const response = await this.sendAndWait({
      type: "set_model",
      provider,
      modelId,
    });

    if (!response.success) {
      throw new Error(response.error ?? "Failed to set model");
    }

    console.log(`[Pi RPC] Model set to ${provider}/${modelId}`);
  }

  /**
   * Get session statistics (tokens, cost, message counts)
   */
  async getSessionStats(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_session_stats" });
  }

  /**
   * Start a new session, optionally tracking the parent session
   */
  async newSession(parentSession?: string): Promise<PiResponse> {
    const command: { type: "new_session"; parentSession?: string } = { type: "new_session" };
    if (parentSession) {
      command.parentSession = parentSession;
    }
    return this.sendAndWait(command);
  }

  send(command: PiCommand): void {
    if (!this.process?.stdin) {
      throw new Error("Pi RPC not running");
    }
    const json = JSON.stringify(command);
    this.process.stdin.write(json + "\n");
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const data = JSON.parse(line) as PiEvent | PiResponse;

      if (data.type === "response") {
        this.emit("response", data as PiResponse);
      } else {
        this.emit("event", data as PiEvent);

        // Emit convenience event for tool results
        if (data.type === "tool_execution_end") {
          this.emit("toolResult", data.toolName, data.result);
        }
      }
    } catch (err) {
      console.error("[Pi RPC] Failed to parse:", line);
    }
  }

  private async sendAndWait(command: PiCommand): Promise<PiResponse> {
    if (!this.isRunning) {
      throw new Error("Pi RPC not running");
    }

    const id = `cmd-${++this.requestId}`;
    const withId = { ...command, id };

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.off("response", onResponse);
        this.off("error", onError);
      };

      const onResponse = (response: PiResponse) => {
        if (response.id !== id) return;
        cleanup();
        if (response.success) {
          resolve(response);
        } else {
          reject(new Error(response.error ?? "Command failed"));
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      this.on("response", onResponse);
      this.on("error", onError);

      this.send(withId);
    });
  }
}
