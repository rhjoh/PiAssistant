import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Inactivity timeout for prompts. If Pi stops emitting events for this long
 * during an active prompt, the prompt is considered hung and cleaned up.
 * Resets on each event (text_delta, tool_execution_update, etc.).
 * Overridable via the `promptInactivityTimeoutMs` constructor option.
 */
const DEFAULT_PROMPT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** HERDR_* variables herdr injects into panes; meaningless for headless RPC children. */
const HERDR_ENV_VARS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_ACTIVE_PANE_ID",
];

function scrubHerdrEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of HERDR_ENV_VARS) {
    delete scrubbed[name];
  }
  return scrubbed;
}
import type { PiCommand, PiEvent, PiResponse, PiState, ThinkingLevel } from "./types.js";

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
  private bufferCleanup: (() => void) | null = null;
  private currentText = "";
  private requestId = 0;
  private parseErrorCount = 0;
  private parseErrorSuppressed = false;
  private activePromptSource: "user" | "internal" | null = null;
  /**
   * True while a submitDuringRun submission may be started by Pi as a NEW root
   * prompt (submit/settle race). When that happens the new run's events arrive
   * with no runPrompt attached, so activePromptSource would stay null and the
   * gateway would suppress them. Set when submitting, cleared at agent_settled.
   */
  private pendingDuringRunSubmission = false;
  private promptQueue: Promise<void> = Promise.resolve();
  /** Reject function for the actively running runPrompt, so we can unstick on crash. */
  private pendingPromptReject: ((err: Error) => void) | null = null;
  /** Cleanup function for the actively running runPrompt, to remove listeners on crash. */
  private pendingPromptCleanup: (() => void) | null = null;
  /** Inactivity timeout handle for the currently active prompt (resets on each Pi event). */
  private promptInactivityTimer: NodeJS.Timeout | null = null;
  private startupExitHandler: (() => void) | null = null;

  constructor(
    private sessionPath: string,
    private cwd: string,
    private options: {
      extensions?: string[];
      excludeTools?: string[];
      provider?: string;
      model?: string;
      /** Inactivity timeout for active prompts (default: 5 minutes). */
      promptInactivityTimeoutMs?: number;
      /** How long the process must survive after spawn before start() resolves (default: 500ms). */
      startupGraceMs?: number;
      /** Test seam: override the child-process spawn implementation. */
      spawnImpl?: typeof spawn;
    } = {}
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

    const startWithConfiguredModel = Boolean(this.options.model);
    let started = await this.startProcess(thinkingLevel, startWithConfiguredModel);
    if (!started && startWithConfiguredModel) {
      const configured = this.options.provider
        ? `${this.options.provider}/${this.options.model}`
        : this.options.model;
      console.warn(
        `[PiRpc] Failed to start with configured model ${configured}; falling back to Pi session default`
      );
      started = await this.startProcess(thinkingLevel, false);
    }

    if (!started) {
      throw new Error("Pi RPC exited during startup");
    }

    this.emit("ready");
  }

  private buildArgs(thinkingLevel: string | undefined, includeConfiguredModel: boolean): string[] {
    const args = ["--mode", "rpc", "--session", this.sessionPath];

    if (includeConfiguredModel && this.options.model) {
      if (this.options.provider) {
        args.push("--provider", this.options.provider);
      }
      args.push("--model", this.options.model);
    }

    for (const extension of this.options.extensions ?? []) {
      args.push("-e", extension);
    }

    const excludeTools = this.options.excludeTools ?? [];
    if (excludeTools.length > 0) {
      args.push("--exclude-tools", excludeTools.join(","));
    }

    // Add thinking level if specified (for models that support it)
    if (thinkingLevel && thinkingLevel !== "off") {
      args.push("--thinking", thinkingLevel);
    }

    return args;
  }

  private async startProcess(thinkingLevel: string | undefined, includeConfiguredModel: boolean): Promise<boolean> {
    const args = this.buildArgs(thinkingLevel, includeConfiguredModel);
    const spawnFn = this.options.spawnImpl ?? spawn;

    this.process = spawnFn("pi", args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Headless RPC mode must not look like an interactive agent to herdr:
      // strip the pane/socket env (HERDR_ENV, HERDR_PANE_ID, HERDR_SOCKET_PATH,
      // ...) inherited from the gateway's launching pane, or the herdr
      // integration extension would register this pane as a Pi agent even
      // though there is no PTY/TUI. See herdr-agent-state.ts mode gate.
      env: scrubHerdrEnv(process.env),
    });

    this.bufferCleanup = attachJsonlReader(this.process.stdout!, (line) => this.handleLine(line));

    this.process.stderr?.on("data", (data) => {
      const msg = data.toString().trim();
      console.error(`[Pi stderr] Output captured (${msg.length} chars)`);
      // Propagate API/provider errors (quota exceeded, plan cancelled, etc.) to listeners
      if (this.activePromptSource === "user") {
        this.emit("error", new Error(`Pi error: ${msg}`));
      }
    });

    this.process.on("exit", (code) => {
      this.process = null;
      this.bufferCleanup = null;
      if (this.startupExitHandler) {
        const handler = this.startupExitHandler;
        this.startupExitHandler = null;
        handler();
        return;
      }
      // 🛡️ FIX 1: Clean up active prompt state so isPromptActive doesn't get stuck forever
      if (this.activePromptSource !== null) {
        console.warn(
          `[Pi RPC] Process exited (code=${code}) with active prompt (source=${this.activePromptSource}) - cleaning up`
        );
        this.activePromptSource = null;
      }
      this.pendingDuringRunSubmission = false;
      if (this.pendingPromptReject) {
        this.pendingPromptReject(new Error(`Pi process exited with code ${code}`));
        this.pendingPromptReject = null;
        this.pendingPromptCleanup = null;
      }
      if (this.promptInactivityTimer) {
        clearTimeout(this.promptInactivityTimer);
        this.promptInactivityTimer = null;
      }
      this.emit("exit", code);
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    return this.waitForProcessToSurviveStartup();
  }

  private waitForProcessToSurviveStartup(): Promise<boolean> {
    const startupGraceMs = this.options.startupGraceMs ?? 500;

    return new Promise<boolean>((resolve) => {
      const markStarted = () => {
        this.startupExitHandler = null;
        resolve(this.isRunning);
      };

      const markFailed = () => { // This is called by the handler() func on "exit" events.
        clearTimeout(startupTimer);
        resolve(false);
      };

      const startupTimer = setTimeout(markStarted, startupGraceMs);
      this.startupExitHandler = markFailed;
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
      this.bufferCleanup = null;
    }
    // 🛡️ FIX 1b: Clean up state if stop() is called during an active prompt
    if (this.pendingPromptReject) {
      this.pendingPromptReject(new Error("Pi RPC stopped"));
      this.pendingPromptReject = null;
      this.pendingPromptCleanup = null;
    }
    if (this.promptInactivityTimer) {
      clearTimeout(this.promptInactivityTimer);
      this.promptInactivityTimer = null;
    }
    this.activePromptSource = null;
    this.pendingDuringRunSubmission = false;
  }

  async prompt(
    message: string,
    options?: { source?: "user" | "internal"; id?: string }
  ): Promise<string> {
    return this.enqueuePrompt(() =>
      this.runPrompt(
        { type: "prompt", message, id: options?.id ?? `req-${++this.requestId}` },
        options?.source ?? "user"
      )
    );
  }

  /**
   * Send a prompt with image attachments.
   * Images should be base64-encoded strings with their mime types.
   */
  async promptWithImages(
    message: string,
    images: { data: string; mimeType: string }[],
    options?: { source?: "user" | "internal"; id?: string }
  ): Promise<string> {
    const id = options?.id ?? `req-${++this.requestId}`;

    // Format images for Pi RPC protocol
    const imageContents = images.map((img) => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));

    console.log(`[Pi RPC] Sending prompt with ${images.length} image(s) (chars=${message.length})`);

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

  /**
   * Submit a steering or follow-up message to the currently active Pi run.
   *
   * Sent immediately through sendAndWait() — deliberately NOT through
   * `promptQueue` or `runPrompt()`. Pi owns the queue decision: if the run is
   * still active, Pi queues the message per `streamingBehavior`; if the run
   * settled in the meantime, Pi starts it as a normal prompt. The returned
   * response reflects Pi's acceptance/rejection of that decision.
   *
   * Note: sendAndWait assigns the correlation id used in the RPC command, so
   * `options.id` is only used for logging - pending-queue matching is FIFO.
   */
  async submitDuringRun(
    message: string,
    behavior: "steer" | "followUp",
    options?: {
      source?: "user" | "internal";
      id?: string;
      images?: { data: string; mimeType: string }[];
    }
  ): Promise<PiResponse> {
    const command: Extract<PiCommand, { type: "prompt" }> = {
      type: "prompt",
      message,
      streamingBehavior: behavior,
    };
    if (options?.images && options.images.length > 0) {
      command.images = options.images.map((img) => ({
        type: "image",
        data: img.data,
        mimeType: img.mimeType,
      }));
    }

    console.log(
      `[Pi RPC] Submit during run (${behavior}, ${options?.source ?? "user"}, pendingId=${options?.id ?? "n/a"}, chars=${message.length})`
    );

    this.pendingDuringRunSubmission = true;
    return this.sendAndWait(command);
  }

  async getState(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_state" });
  }

  async getAvailableModels(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_available_models" });
  }

  async getAvailableThinkingLevels(): Promise<PiResponse> {
    return this.sendAndWait({ type: "get_available_thinking_levels" });
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
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
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

  /**
   * Forcefully reject the active prompt without waiting for Pi to emit
   * agent_end. Used by abort escalation to unstick the gateway when a tool
   * call ignores the abort signal and Pi never settles the turn.
   */
  forceRejectActivePrompt(reason: string): void {
    if (this.pendingPromptReject) {
      console.warn(`[PiRpc] Force-rejecting active prompt: ${reason}`);
      const reject = this.pendingPromptReject;
      const cleanup = this.pendingPromptCleanup;
      // Cleanup first (removes listeners, clears timer + activePromptSource),
      // then reject so the caller's .catch fires with our reason.
      cleanup?.();
      reject(new Error(reason));
    } else if (this.activePromptSource !== null) {
      // No pending promise to reject but Pi state is stale — clear it anyway.
      console.warn(`[PiRpc] Clearing stale active prompt state: ${reason}`);
      this.activePromptSource = null;
    }
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
      console.debug(
        `[Pi RPC] Prompt start (${source}) id=${promptId} chars=${command.message.length} queueActive=${this.isPromptActive}`
      );

      // 🛡️ Track cleanup and reject so we can unstick on process crash
      const cleanup = () => {
        this.off("event", onEvent);
        this.off("error", onError);
        this.pendingPromptReject = null;
        this.pendingPromptCleanup = null;
        if (this.promptInactivityTimer) {
          clearTimeout(this.promptInactivityTimer);
          this.promptInactivityTimer = null;
        }
        this.activePromptSource = null;
      };

      const resetInactivityTimer = () => {
        if (this.promptInactivityTimer) {
          clearTimeout(this.promptInactivityTimer);
        }
        const timeoutMs = this.options.promptInactivityTimeoutMs ?? DEFAULT_PROMPT_INACTIVITY_TIMEOUT_MS;
        this.promptInactivityTimer = setTimeout(() => {
          const err = new Error(
            `Prompt timed out after ${timeoutMs / 1000}s of inactivity (source=${source})`
          );
          console.error(`[Pi RPC] ${err.message}`);
          this.promptInactivityTimer = null;
          cleanup();
          reject(err);
        }, timeoutMs);
        // Don't keep Node alive for this timer alone
        this.promptInactivityTimer.unref();
      };

      // Store references for crash recovery
      this.pendingPromptReject = reject;
      this.pendingPromptCleanup = cleanup;

      // One runPrompt promise can span several low-level Pi runs (retry,
      // compaction recovery, queued continuations). agent_end is NOT final:
      // only agent_settled is. This guard makes settlement exactly-once even
      // if abort escalation, process exit, or a race fires first.
      let settled = false;
      let lastUsageSummary = "none";

      const settle = () => {
        if (settled) return;
        settled = true;
        const finalText = this.currentText;
        console.log(
          `[Pi RPC] Run settled (${source}) id=${promptId} finalLen=${finalText.length} usage=${lastUsageSummary}`
        );
        cleanup();
        resolve(finalText);
      };

      const onEvent = (event: PiEvent) => {
        // Reset inactivity timer on any event from Pi
        resetInactivityTimer();

        if (event.type === "agent_start") {
          // A new low-level run begins (first run, retry, or queued
          // continuation). Accumulated text belongs to the previous run.
          this.currentText = "";
          console.log(`[Pi RPC] Event agent_start (${source}) id=${promptId}`);
        } else if (event.type === "message_start") {
          const msg = event.message;
          if (msg.role === "user") {
            console.log(
              `[Pi RPC] Event message_start user (${source}) id=${promptId}`
            );
          } else {
            console.debug(`[Pi RPC] Event message_start ${msg.role} (${source}) id=${promptId}`);
          }
        } else if (event.type === "message_end") {
          console.debug(`[Pi RPC] Event message_end ${event.message.role} (${source}) id=${promptId}`);
        } else if (event.type === "turn_start") {
          console.debug(`[Pi RPC] Event turn_start (${source}) id=${promptId}`);
        } else if (event.type === "turn_end") {
          console.debug(`[Pi RPC] Event turn_end (${source}) id=${promptId}`);
        } else if (event.type === "queue_update") {
          console.log(
            `[Pi RPC] Event queue_update (${source}) id=${promptId} steering=${event.steering.length} followUp=${event.followUp.length}`
          );
        } else if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            this.currentText += event.assistantMessageEvent.delta;
            this.emit("text", this.currentText);
          } else if (event.assistantMessageEvent.type === "text_done") {
            // Use Pi's finalized text; it can include corrected spacing vs raw deltas.
            this.currentText = event.assistantMessageEvent.text;
            console.log(
              `[Pi RPC] Event text_done (${source}) id=${promptId} total=${this.currentText.length}`
            );
            this.emit("text", this.currentText);
          } else if (event.assistantMessageEvent.type === "thinking_delta") {
            // Suppressed from log file — too noisy during streaming.
            // Use console.debug for foreground visibility without polluting logs.
            console.debug(
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
          const partialLength = this.serializedLength(event.partialResult);
          // Suppressed from log file — too noisy during streaming.
          console.debug(
            `[Pi RPC] Event tool_execution_update (${source}) id=${promptId} tool=${event.toolName} call=${event.toolCallId} resultChars=${partialLength}`
          );
        } else if (event.type === "tool_execution_end") {
          console.log(
            `[Pi RPC] Event tool_execution_end (${source}) id=${promptId} tool=${event.toolName} call=${event.toolCallId} isError=${event.isError} resultChars=${this.serializedLength(event.result)}`
          );
        } else if (event.type === "agent_end") {
          lastUsageSummary = this.extractUsageSummary(event);
          console.log(
            `[Pi RPC] Event agent_end (${source}) id=${promptId} finalLen=${this.currentText.length} willRetry=${event.willRetry ?? false} usage=${lastUsageSummary}`
          );
          // One low-level run is done, but the session-level run may continue
          // (retry, compaction recovery, queued steering/follow-up). Do NOT
          // resolve or clear state here — agent_settled is the idle boundary.
        } else if (event.type === "agent_settled") {
          settle();
        } else if (event.type === "response") {
          console.log(
            `[Pi RPC] Event response (${source}) id=${promptId} command=${event.command} success=${event.success}`
          );
        } else if (event.type === "compaction_start") {
          console.log(`[Pi RPC] Event compaction_start reason=${event.reason}`);
        } else if (event.type === "compaction_end") {
          console.log(
            `[Pi RPC] Event compaction_end aborted=${event.aborted} willRetry=${event.willRetry ?? false} tokensBefore=${event.result?.tokensBefore ?? "n/a"}`
          );
        } else if (event.type === "auto_compaction_start") {
          console.log(`[Pi RPC] Event auto_compaction_start reason=${event.reason}`);
        } else if (event.type === "auto_compaction_end") {
          console.log(
            `[Pi RPC] Event auto_compaction_end aborted=${event.aborted} willRetry=${event.willRetry} tokensBefore=${event.result?.tokensBefore ?? "n/a"}`
          );
        } else if (event.type === "auto_retry_start") {
          console.log(`[Pi RPC] Event auto_retry_start`);
        } else if (event.type === "auto_retry_end") {
          console.log(`[Pi RPC] Event auto_retry_end success=${event.success}`);
        }
      };

      const onError = (err: Error) => {
        console.error(`[Pi RPC] Prompt error (${source}) id=${promptId}:`, err);
        cleanup();
        reject(err);
      };

      this.on("event", onEvent);
      this.on("error", onError);

      // Start the inactivity timer
      resetInactivityTimer();

      this.send(command);
    });
  }

  private serializedLength(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (value === null || value === undefined) return 0;
    try {
      return JSON.stringify(value)?.length ?? 0;
    } catch {
      return 0;
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
        // Submit/settle race: Pi started a submitDuringRun submission as a new
        // root prompt. Mark it as a user run so events are not suppressed.
        if (
          data.type === "agent_start" &&
          this.activePromptSource === null &&
          this.pendingDuringRunSubmission
        ) {
          console.log("[Pi RPC] Treating raced agent_start as a user run (submitDuringRun submission)");
          this.activePromptSource = "user";
        }
        if (data.type === "agent_settled") {
          this.pendingDuringRunSubmission = false;
        }
        this.emit("event", data as PiEvent);

        // Emit convenience event for tool results
        if (data.type === "tool_execution_end") {
          this.emit("toolResult", data.toolName, data.result);
        }
      }
    } catch (err) {
      this.parseErrorCount++;
      if (this.parseErrorCount <= 5) {
        console.error(`[Pi RPC] Failed to parse event (${trimmed.length} chars)`);
      } else if (!this.parseErrorSuppressed) {
        console.error("[Pi RPC] Suppressing further parse errors...");
        this.parseErrorSuppressed = true;
      }
    }
  }

  private async sendAndWait(command: PiCommand, timeoutMs = 30_000): Promise<PiResponse> {
    if (!this.isRunning) {
      throw new Error("Pi RPC not running");
    }

    const id = `cmd-${++this.requestId}`;
    const withId = { ...command, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Pi RPC timed out after ${timeoutMs}ms: ${command.type}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
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

/**
 * Attach a JSON-lines reader to a readable stream.
 * Splits only on \\n (protocol-compliant) — unlike Node's readline which also
 * splits on U+2028 and U+2029 (valid inside JSON strings).
 */
function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): () => void {
  let buffer = "";

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };

  const onEnd = () => {
    if (buffer.length > 0) onLine(buffer);
    buffer = "";
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    buffer = "";
  };
}
