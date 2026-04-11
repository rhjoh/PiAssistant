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
  private parseErrorCount = 0;
  private parseErrorSuppressed = false;
  private activePromptSource: "user" | "internal" | null = null;
  private promptQueue: Promise<void> = Promise.resolve();

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

  get promptSource(): "user" | "internal" | null {
    return this.activePromptSource;
  }

  get isPromptActive(): boolean {
    return this.activePromptSource !== null;
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

  async start(thinkingLevel?: string): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // IMPORTANT: Don't pass --provider/--model to Pi
    // Let Pi restore model from session's model_change entry
    // We'll send set_model via RPC after Pi is ready if needed
    const args = ["--mode", "rpc", "--session", this.sessionPath];
    
    // Add thinking level if specified (for models that support it)
    if (thinkingLevel && thinkingLevel !== "off") {
      args.push("--thinking", thinkingLevel);
    }

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

  async prompt(
    message: string,
    options?: { source?: "user" | "internal" }
  ): Promise<string> {
    return this.enqueuePrompt(() =>
      this.runPrompt({ type: "prompt", message, id: `req-${++this.requestId}` }, options?.source ?? "user")
    );
  }

  /**
   * Send a prompt with image attachments.
   * Images should be base64-encoded strings with their mime types.
   */
  async promptWithImages(
    message: string,
    images: { data: string; mimeType: string }[],
    options?: { source?: "user" | "internal" }
  ): Promise<string> {
    const id = `req-${++this.requestId}`;

    // Format images for Pi RPC protocol
    const imageContents = images.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));

    // Log the full JSON being sent (first 500 chars to avoid huge logs)
    const payload = {
      type: "prompt",
      message,
      images: imageContents.map((img) => ({ ...img, data: img.data.substring(0, 100) + "..." })),
      id,
    };
    console.log(`[Pi RPC] Sending prompt with ${images.length} image(s):`);
    console.log(`[Pi RPC] Payload preview:`, JSON.stringify(payload).substring(0, 500));

    return this.enqueuePrompt(() =>
      this.runPrompt(
        {
          type: "prompt",
          message,
          images: imageContents,
          id,
        },
        options?.source ?? "user"
      )
    );
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
   * Set thinking level for models that support it (off, minimal, low, medium, high, xhigh)
   */
  async setThinkingLevel(level: string): Promise<void> {
    const response = await this.sendAndWait({
      type: "set_thinking_level",
      level,
    });

    if (!response.success) {
      throw new Error(response.error ?? "Failed to set thinking level");
    }

    console.log(`[Pi RPC] Thinking level set to ${level}`);
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

  private enqueuePrompt(task: () => Promise<string>): Promise<string> {
    const run = this.promptQueue.then(task, task);
    this.promptQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private runPrompt(
    command: Extract<PiCommand, { type: "prompt" }>,
    source: "user" | "internal"
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning) {
        reject(new Error("Pi RPC not running"));
        return;
      }

      this.currentText = "";
      this.activePromptSource = source;
      const promptId = command.id ?? `prompt-${Date.now()}`;
      const promptPreview = this.previewText(command.message);

      console.log(
        `[Pi RPC] Prompt start (${source}) id=${promptId} text="${promptPreview}" queueActive=${this.isPromptActive}`
      );

      const cleanup = () => {
        this.off("event", onEvent);
        this.off("error", onError);
        this.activePromptSource = null;
      };

      const onEvent = (event: PiEvent) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            this.currentText += event.assistantMessageEvent.delta;
            console.log(
              `[Pi RPC] Event text_delta (${source}) id=${promptId} delta=${event.assistantMessageEvent.delta.length} total=${this.currentText.length}`
            );
            this.emit("text", this.currentText);
          } else if (event.assistantMessageEvent.type === "text_done") {
            // Use Pi's finalized text; it can include corrected spacing vs raw deltas.
            this.currentText = event.assistantMessageEvent.text;
            console.log(
              `[Pi RPC] Event text_done (${source}) id=${promptId} total=${this.currentText.length} preview="${this.previewText(this.currentText)}"`
            );
            this.emit("text", this.currentText);
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            console.log(
              `[Pi RPC] Event thinking_delta (${source}) id=${promptId} delta=${event.assistantMessageEvent.delta.length}`
            );
          } else if (event.assistantMessageEvent.type === "thinking_done") {
            console.log(`[Pi RPC] Event thinking_done (${source}) id=${promptId}`);
          }
        } else if (event.type === "tool_execution_start") {
          console.log(
            `[Pi RPC] Event tool_execution_start (${source}) id=${promptId} tool=${event.toolName} call=${event.toolCallId}`
          );
        } else if (event.type === "tool_execution_update") {
          const partialLength = this.previewUnknown(event.partialResult).length;
          console.log(
            `[Pi RPC] Event tool_execution_update (${source}) id=${promptId} tool=${event.toolName} call=${event.toolCallId} previewChars=${partialLength}`
          );
        } else if (event.type === "tool_execution_end") {
          console.log(
            `[Pi RPC] Event tool_execution_end (${source}) id=${promptId} tool=${event.toolName} call=${event.toolCallId} isError=${event.isError} resultPreview="${this.previewUnknown(event.result)}"`
          );
        } else if (event.type === "agent_end") {
          const finalText = this.currentText;
          const usage = this.extractUsageSummary(event);
          console.log(
            `[Pi RPC] Event agent_end (${source}) id=${promptId} finalLen=${finalText.length} usage=${usage} preview="${this.previewText(finalText)}"`
          );
          cleanup();
          resolve(finalText);
        } else if (event.type === "response") {
          console.log(
            `[Pi RPC] Event response (${source}) id=${promptId} command=${event.command} success=${event.success}`
          );
        } else if (event.type === "auto_compaction_start") {
          console.log(`[Pi RPC] Event auto_compaction_start reason=${event.reason}`);
        } else if (event.type === "auto_compaction_end") {
          console.log(
            `[Pi RPC] Event auto_compaction_end aborted=${event.aborted} willRetry=${event.willRetry} tokensBefore=${event.result?.tokensBefore ?? "n/a"}`
          );
        }
      };

      const onError = (err: Error) => {
        console.error(`[Pi RPC] Prompt error (${source}) id=${promptId}:`, err);
        cleanup();
        reject(err);
      };

      this.on("event", onEvent);
      this.on("error", onError);

      this.send(command);
    });
  }

  private previewText(text: string, max = 120): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max)}...`;
  }

  private previewUnknown(value: unknown, max = 120): string {
    if (typeof value === "string") return this.previewText(value, max);
    if (value === null || value === undefined) return String(value);
    try {
      return this.previewText(JSON.stringify(value), max);
    } catch {
      return "[unserializable]";
    }
  }

  private extractUsageSummary(event: Extract<PiEvent, { type: "agent_end" }>): string {
    const lastAssistant = [...(event.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    const usage = lastAssistant?.usage;
    if (!usage) return "none";

    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const total = input + output + cacheRead + cacheWrite;
    return `in=${input} out=${output} cacheRead=${cacheRead} cacheWrite=${cacheWrite} total=${total}`;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Ignore plain log lines from extensions/non-RPC output.
    if (!trimmed.startsWith("{")) {
      return;
    }

    try {
      const data = JSON.parse(trimmed) as PiEvent | PiResponse;
      this.parseErrorCount = 0; // Reset on success
      this.parseErrorSuppressed = false;

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
      this.parseErrorCount++;
      if (this.parseErrorCount <= 5) {
        console.error("[Pi RPC] Failed to parse:", trimmed.slice(0, 200));
      } else if (!this.parseErrorSuppressed) {
        console.error("[Pi RPC] Suppressing further parse errors...");
        this.parseErrorSuppressed = true;
      }
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
