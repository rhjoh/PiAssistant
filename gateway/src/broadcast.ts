import type { EventEmitter } from "node:events";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent, PiAgentMessage, PiModelInfo, PiState } from "./types.js";
import type {
  Client,
  QueuedPrompt,
  StreamingBehavior,
  ThinkingLevel,
  TokenUsage,
  WSServerMessage,
  WSModelInfo,
  WSStateData,
} from "./types-ws.js";
import type { SessionManager } from "./session-manager.js";
import { rememberToolLabel } from "./tool-call-cache.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/** Mirror Pi's model-specific thinking-level capability rule. */
export function thinkingLevelsForModel(
  model: Pick<PiModelInfo, "reasoning" | "thinkingLevelMap">
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function toWSModelInfo(model: PiModelInfo): WSModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    thinkingLevels: thinkingLevelsForModel(model),
  };
}

/** Gateway-side record of a busy-time prompt accepted by Pi, pending consumption. */
interface PendingQueuedPrompt extends QueuedPrompt {
  images?: { data: string; mimeType: string }[];
}

/** Internal acceptance request for one client prompt submission. */
interface PromptAcceptance {
  message: string;
  images?: { data: string; mimeType: string; path?: string }[];
  originatingClientId: string;
  requestedTurnId?: string;
  streamingBehavior?: StreamingBehavior;
}

/**
 * BroadcastManager handles multi-client message distribution.
 * 
 * Architecture:
 * - Pi RPC emits events (tool_start, text_delta, etc.)
 * - BroadcastManager receives events and forwards to all connected clients
 * - Telegram and WebSocket clients are treated equally
 * 
 * This allows multiple clients to see the same conversation simultaneously.
 *
 * Run model: one session-level run (currentPrompt) can contain several logical
 * turns. A user message submitted while a run is active is queued with Pi
 * (steer/followUp) and becomes a new logical turn when Pi starts consuming it.
 * The run stays busy until Pi emits agent_settled.
 */
export class BroadcastManager {
  private clients = new Map<string, Client>();
  /** The session-level run claimed by the gateway (until agent_settled). */
  private currentPrompt:
    | {
        message: string;
        turnId: string;
        clientIds: Set<string>;
        startedAt: number;
        originClientId: string;
        origin: "user" | "task";
        taskId?: string;
        taskRunId?: string;
        taskName?: string;
      }
    | null = null;
  /** The logical turn currently streaming (switches on consumed queued messages). */
  private activeTurn: { turnId: string; originClientId: string } | null = null;
  /** Gateway-tracked pending steering messages, in Pi delivery (FIFO) order. */
  private pendingSteering: PendingQueuedPrompt[] = [];
  /** Gateway-tracked pending follow-up messages, in Pi delivery (FIFO) order. */
  private pendingFollowUps: PendingQueuedPrompt[] = [];
  /** Whether the last Pi queue_update reported any queued items. */
  private lastPiQueueHadItems = false;
  /** Pending entries cleared at agent_settled, kept briefly to resolve submit/settle races. */
  private recentlySettledPending: { entry: PendingQueuedPrompt; clearedAt: number }[] = [];
  /** Usage of the most recently completed low-level run (segment). */
  private lastSegmentUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number }
    | undefined;
  private sessionManager: SessionManager | null = null;
  private lastUserActivityAt = 0;
  private promptQueue: Promise<unknown> = Promise.resolve();
  /** Serializes model/thinking mutations from competing clients. */
  private controlQueue: Promise<void> = Promise.resolve();
  // Cumulative session token usage
  private cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

  private broadcastThinking: boolean;
  private abortGraceMs: number;
  private clientSendTimeoutMs: number;
  private eventHandlerTimeoutMs: number;

  constructor(
    private pi: PiRpcClient,
    options?: {
      broadcastThinking?: boolean;
      /** How long abort() waits for the prompt to settle before force-clearing. */
      abortGraceMs?: number;
      /** Per-client send timeout so a hung client can't stall broadcasts. */
      clientSendTimeoutMs?: number;
      /** Per-event handler timeout so the event queue can never wedge. */
      eventHandlerTimeoutMs?: number;
    }
  ) {
    this.broadcastThinking = options?.broadcastThinking ?? true;
    this.abortGraceMs = options?.abortGraceMs ?? 8000;
    this.clientSendTimeoutMs = options?.clientSendTimeoutMs ?? 8000;
    this.eventHandlerTimeoutMs = options?.eventHandlerTimeoutMs ?? 30000;
    this.setupPiListeners();
    this.setupPiExitHandler();
  }

  /**
   * Set the session manager for handling /new commands
   */
  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  /**
   * Register a client to receive broadcast messages
   */
  registerClient(client: Client): void {
    this.clients.set(client.id, client);
    console.log(`[Broadcast] Client registered: ${client.type} (${client.id})`);
  }

  /**
   * Unregister a client
   */
  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    console.log(`[Broadcast] Client unregistered: ${clientId}`);
  }

  /**
   * Get all registered clients
   */
  getClients(): Client[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get count of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Send a prompt to Pi and broadcast to all clients.
   *
   * - Idle: starts a root prompt.
   * - Active user run: queues the message with Pi (steer by default, followUp
   *   if requested) - it is NOT rejected and NOT run through any FIFO.
   * - Active internal/task work: rejected or queued behind it (see acceptPrompt).
   *
   * Returns the clients that will receive this response.
   */
  sendPrompt(
    message: string,
    originatingClientId: string,
    requestedTurnId?: string,
    streamingBehavior?: StreamingBehavior
  ): Promise<Set<string>> {
    return this.acceptPrompt({ message, originatingClientId, requestedTurnId, streamingBehavior });
  }

  async sendTaskPrompt(input: {
    taskId: string;
    runId: string;
    taskName: string;
    prompt: string;
  }): Promise<string> {
    const run = this.promptQueue.then(() => this.runTaskPrompt(input));
    this.promptQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Send a prompt with images to Pi and broadcast to all clients.
   * Same acceptance semantics as sendPrompt (root, steer, or followUp).
   */
  sendPromptWithImages(
    message: string,
    images: { data: string; mimeType: string; path?: string }[],
    originatingClientId: string,
    requestedTurnId?: string,
    streamingBehavior?: StreamingBehavior
  ): Promise<Set<string>> {
    return this.acceptPrompt({
      message,
      images,
      originatingClientId,
      requestedTurnId,
      streamingBehavior,
    });
  }

  /**
   * Single serialized acceptance path for all user prompt submissions
   * (text and images). The decision (root start vs steer vs followUp) is made
   * inside the serialized queue so two simultaneous idle submissions cannot
   * both start a root prompt.
   */
  private acceptPrompt(input: PromptAcceptance): Promise<Set<string>> {
    let resolveResult!: (value: Set<string>) => void;
    let rejectResult!: (error: Error) => void;
    const resultPromise = new Promise<Set<string>>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const run = this.promptQueue.then(() => this.decideAndAccept(input));
    this.promptQueue = run.then(
      () => undefined,
      () => undefined
    );
    run.then(resolveResult).catch((err) => {
      try {
        rejectResult(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* already settled */
      }
    });
    return resultPromise;
  }

  /**
   * Decide whether this submission starts a root prompt or is queued with the
   * active run, and execute that decision. Runs inside the serialized
   * promptQueue chain.
   */
  private async decideAndAccept(input: PromptAcceptance): Promise<Set<string>> {
    this.lastUserActivityAt = Date.now();

    if (this.currentPrompt) {
      if (this.currentPrompt.origin === "task") {
        throw new Error("Assistant is busy with a scheduled task");
      }
      // A user run is claimed by the gateway. Queue with Pi (never reject),
      // unless Pi is still executing internal work - steering would otherwise
      // be injected ahead of the user's own root prompt.
      if (this.pi.promptSource === "internal") {
        throw new Error("Assistant is still finishing internal work - try again shortly");
      }
      if (this.pi.promptSource === null) {
        throw new Error("Assistant is starting your prompt - try again in a moment");
      }
      const behavior = input.streamingBehavior ?? "steer";
      return this.submitQueuedPrompt(input, behavior);
    }

    if (this.pi.isPromptActive && this.pi.promptSource === "user") {
      // Pi is running a user-source run the gateway has not claimed yet: a
      // submitDuringRun submission Pi started as a fresh root prompt during a
      // submit/settle race. Steer it like any other active user run.
      const behavior = input.streamingBehavior ?? "steer";
      return this.submitQueuedPrompt(input, behavior);
    }

    if (this.pi.isPromptActive) {
      // Internal prompt (heartbeat) in flight and no user run claimed. Queue
      // the root prompt behind it via Pi's own FIFO (existing behavior).
      console.log("[Broadcast] User prompt queued behind active internal prompt (heartbeat)");
      return this.startRootPrompt(input);
    }

    // Idle: start a root prompt normally. streamingBehavior is harmless here
    // (Pi ignores it when idle).
    return this.startRootPrompt(input);
  }

  /**
   * Start a root prompt (idle gateway or queued behind internal work).
   */
  private async startRootPrompt(input: PromptAcceptance): Promise<Set<string>> {
    const clientIds = new Set(this.clients.keys());
    const turnId = this.resolveTurnId(input.requestedTurnId, input.originatingClientId);
    this.currentPrompt = {
      message: input.message,
      turnId,
      clientIds,
      startedAt: Date.now(),
      originClientId: input.originatingClientId,
      origin: "user",
    };
    this.activeTurn = { turnId, originClientId: input.originatingClientId };

    console.log(
      `[Broadcast] Prompt processing started (from ${input.originatingClientId}, ${clientIds.size} client${clientIds.size === 1 ? "" : "s"}, chars=${input.message.length})${input.images ? ` (${input.images.length} image(s))` : ""}`
    );

    await this.broadcast(
      {
        type: "user_message",
        data: { content: input.message, source: input.originatingClientId, ...this.turnMetadata() },
      },
      input.originatingClientId
    );

    // The originating client normally renders an idle submission optimistically.
    // Still acknowledge the root prompt explicitly: its local busy state can be
    // stale after an abort/reconnect, in which case it will have retained the
    // composer text while waiting for a prompt_queued acknowledgement.
    const submittingClient = this.clients.get(input.originatingClientId);
    if (submittingClient?.isAvailable()) {
      await submittingClient.send({
        type: "prompt_accepted",
        data: { id: turnId, content: input.message, originClientId: input.originatingClientId },
      });
    }

    const onPromptError = (err: unknown): void => {
      console.error("[Broadcast] Pi prompt error:", err);
      // If the prompt was already force-cleared by abort escalation, don't
      // double-broadcast the error or clobber a newer turn's state.
      if (!this.currentPrompt) return;
      const metadata = this.turnMetadata();
      this.resetRunState();
      this.broadcast({
        type: "error",
        data: { message: err instanceof Error ? err.message : "Unknown error", ...metadata },
      });
    };

    if (input.images && input.images.length > 0) {
      // Strip paths before sending to Pi (Pi only needs base64).
      const piImages = input.images.map(({ data, mimeType }) => ({ data, mimeType }));
      this.pi
        .promptWithImages(input.message, piImages, { source: "user", id: turnId })
        .catch(onPromptError);
    } else {
      this.pi.prompt(input.message, { source: "user", id: turnId }).catch(onPromptError);
    }

    return clientIds;
  }

  /**
   * Submit a busy-time prompt to the active Pi run (steer or followUp).
   * Sent immediately to Pi - never through the gateway or Pi prompt FIFOs.
   */
  private async submitQueuedPrompt(
    input: PromptAcceptance,
    behavior: StreamingBehavior
  ): Promise<Set<string>> {
    const id = this.resolveTurnId(input.requestedTurnId, input.originatingClientId);
    const entry: PendingQueuedPrompt = {
      id,
      content: input.message,
      behavior,
      originClientId: input.originatingClientId,
      images: input.images?.map(({ data, mimeType }) => ({ data, mimeType })),
    };

    const target = behavior === "followUp" ? this.pendingFollowUps : this.pendingSteering;
    target.push(entry);

    try {
      // Pi's acceptance is authoritative: if the previous run settled during
      // the race, Pi starts this as a normal root prompt instead of queueing.
      await this.pi.submitDuringRun(input.message, behavior, {
        source: "user",
        id,
        images: entry.images,
      });

      const submittingClient = this.clients.get(entry.originClientId);
      if (submittingClient?.isAvailable()) {
        await submittingClient.send({
          type: "prompt_queued",
          data: { id: entry.id, content: entry.content, behavior: entry.behavior, originClientId: entry.originClientId },
        });
      }
      await this.broadcastQueueUpdate();
      return new Set(this.clients.keys());
    } catch (err) {
      // Pi rejected preflight - remove the pending entry and surface the error.
      const idx = target.indexOf(entry);
      if (idx !== -1) target.splice(idx, 1);
      console.error(`[Broadcast] Pi rejected ${behavior} submission:`, err);
      await this.broadcastQueueUpdate().catch(() => {});
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Broadcast the current gateway pending queues to all clients.
   */
  private async broadcastQueueUpdate(): Promise<void> {
    const steering: QueuedPrompt[] = this.pendingSteering.map(({ id, content, behavior, originClientId }) => ({
      id,
      content,
      behavior,
      originClientId,
    }));
    const followUp: QueuedPrompt[] = this.pendingFollowUps.map(({ id, content, behavior, originClientId }) => ({
      id,
      content,
      behavior,
      originClientId,
    }));
    await this.broadcast({ type: "queue_update", data: { steering, followUp } });
  }

  /**
   * Pop the pending entry matching a user message Pi just started consuming.
   * Pi delivers steering FIFO before follow-ups, and text may have been
   * expanded (skill/template) so order - not text equality - is authoritative.
   */
  private takePendingForUserMessage(text: string): PendingQueuedPrompt | undefined {
    const entry = this.pendingSteering.shift() ?? this.pendingFollowUps.shift();
    if (entry && entry.content !== text) {
      console.warn(
        `[Broadcast] Queued message text mismatch (expectedChars=${entry.content.length}, gotChars=${text.length}) - using FIFO order`
      );
    }
    return entry;
  }

  /**
   * Recover a pending entry cleared at agent_settled when Pi started it as a
   * fresh root prompt during a submit/settle race. Entries are kept briefly
   * after settlement (Pi emits the new run's message_start within milliseconds).
   */
  private recoverRecentlySettled(text: string): PendingQueuedPrompt | undefined {
    const now = Date.now();
    const RECOVERY_WINDOW_MS = 5000;
    const idx = this.recentlySettledPending.findIndex(
      ({ entry, clearedAt }) => entry.content === text && now - clearedAt < RECOVERY_WINDOW_MS
    );
    if (idx === -1) return undefined;
    const [recovered] = this.recentlySettledPending.splice(idx, 1);
    console.warn(
      `[Broadcast] Recovered settled pending entry as new root prompt (from ${recovered.entry.originClientId})`
    );
    return recovered.entry;
  }

  /**
   * Broadcast a message to all connected clients.
   * Each client's send is capped at `clientSendTimeoutMs` so a single hung
   * client (e.g. a Telegram Bot API call that never settles) can never stall
   * the event pipeline for everyone else.
   */
  async broadcast(message: WSServerMessage, excludeClientId?: string): Promise<void> {
    const results: Promise<void>[] = [];

    for (const [id, client] of this.clients) {
      if (excludeClientId && id === excludeClientId) continue;
      if (!client.isAvailable()) continue;

      try {
        const result = client.send(message);
        if (result instanceof Promise) {
          results.push(
            Promise.race([
              result.catch((err) => {
                console.error(`[Broadcast] Failed to send to ${id}:`, err);
              }),
              new Promise<void>((resolve) => setTimeout(resolve, this.clientSendTimeoutMs)),
            ])
          );
        }
      } catch (err) {
        console.error(`[Broadcast] Failed to send to ${id}:`, err);
      }
    }

    await Promise.all(results);
  }

  /**
   * Get current Pi state for new connections
   */
  async getState(): Promise<{ type: "state"; data: WSStateData }> {
    try {
      const stateResponse = await this.pi.getState();
      const stateData = stateResponse.data as PiState | undefined;

      let availableThinkingLevels = stateData?.model
        ? thinkingLevelsForModel(stateData.model)
        : [...THINKING_LEVELS];
      try {
        const levelsResponse = await this.pi.getAvailableThinkingLevels();
        const levelsData = levelsResponse.data as { levels?: unknown[] } | undefined;
        if (levelsResponse.success && Array.isArray(levelsData?.levels)) {
          const levels = levelsData.levels.filter(isThinkingLevel);
          if (levels.length > 0) availableThinkingLevels = levels;
        }
      } catch (err) {
        console.warn("[Broadcast] Failed to query thinking levels; using model metadata:", err);
      }

      const currentContextTokens = await this.readCurrentContextTokensFromSession();

      return {
        type: "state",
        data: {
          model: stateData?.model ? toWSModelInfo(stateData.model) : undefined,
          contextWindow: stateData?.model?.contextWindow,
          // An empty/fresh session has no assistant usage entry yet. Report
          // zero explicitly so clients replace the previous session's count.
          contextTokens: currentContextTokens ?? 0,
          thinkingLevel: isThinkingLevel(stateData?.thinkingLevel) ? stateData.thinkingLevel : undefined,
          availableThinkingLevels,
          isProcessing: this.isPromptInFlight(),
          sessionUsage: {
            input: this.cumulativeUsage.input,
            output: this.cumulativeUsage.output,
            cacheRead: this.cumulativeUsage.cacheRead,
            cacheWrite: this.cumulativeUsage.cacheWrite,
            total: this.cumulativeUsage.total,
            cost: this.cumulativeUsage.cost || undefined,
          },
        },
      };
    } catch (err) {
      console.error("[Broadcast] getState failed:", err);
      return {
        type: "state",
        data: {
          isProcessing: this.isPromptInFlight(),
          sessionUsage: {
            input: this.cumulativeUsage.input,
            output: this.cumulativeUsage.output,
            cacheRead: this.cumulativeUsage.cacheRead,
            cacheWrite: this.cumulativeUsage.cacheWrite,
            total: this.cumulativeUsage.total,
            cost: this.cumulativeUsage.cost || undefined,
          },
        },
      };
    }
  }

  private async readCurrentContextTokensFromSession(): Promise<number | null> {
    try {
      const { readFile } = await import("node:fs/promises");
      const sessionPath = this.sessionManager?.["sessionPath"] || "";
      if (!sessionPath) return null;

      const content = await readFile(sessionPath, "utf-8");
      const trimmed = content.trim();
      if (!trimmed) return null;

      const lines = trimmed.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
          const usage = entry.message.usage;
          return (usage.cacheRead ?? 0) + (usage.inputTokens ?? 0);
        }
      }
    } catch {
      // ignore - session may be empty/unavailable
    }
    return null;
  }

  /**
   * Abort the current Pi operation, escalating if the prompt doesn't settle.
   *
   * Steps:
   * 1. Clear gateway pending queue metadata (Pi's own queues are cleared by a
   *    process restart below when non-empty - abort alone does not clear them).
   * 2. Ask Pi to abort (works for streaming turns and bash tools).
   * 3. If Pi had queued steering/follow-up messages, restart Pi immediately:
   *    after an aborted run Pi auto-continues with its still-pending queues
   *    (there is no RPC to clear them), which would surprise the user.
   * 4. Otherwise wait up to `abortGraceMs` for the prompt to settle
   *    (agent_settled).
   * 5. If it doesn't settle, force-clear the gateway state (reject the pending
   *    Pi prompt + clear currentPrompt) so clients are never stuck on "busy".
   * 6. If Pi still considers a prompt active (a tool call ignored the abort
   *    signal), restart the Pi RPC process — the session file is durable JSONL,
   *    so this is safe and always kills the stuck tool.
   */
  /** In-flight abort escalation. A second abort press sets `force` to skip the grace wait. */
  private abortEscalation: { promise: Promise<void>; force: boolean } | null = null;

  async abort(): Promise<void> {
    // A repeated abort press (e.g. user hits escape again) escalates immediately
    // instead of waiting out the grace period.
    if (this.abortEscalation) {
      this.abortEscalation.force = true;
      return this.abortEscalation.promise;
    }

    const hadPendingQueues = this.pendingSteering.length > 0 || this.pendingFollowUps.length > 0;
    const piQueueHadItems = this.lastPiQueueHadItems || hadPendingQueues;

    // Clear gateway pending metadata up front so client indicators disappear.
    if (hadPendingQueues) {
      this.clearPendingQueues();
      await this.broadcastQueueUpdate();
    }

    if (!this.isPromptInFlight()) {
      await this.broadcast({ type: "state", data: { isProcessing: false } });
      await this.broadcast({
        type: "abort_complete",
        data: { forced: false, restarted: false, message: "No active prompt to abort. Ready for a new message." },
      });
      return;
    }

    this.pi.abort();

    if (piQueueHadItems) {
      // Pi's abort does not clear its in-memory steering/follow-up queues, and
      // after the aborted run ends its session auto-continues with them
      // (_handlePostAgentRun -> agent.continue()). No RPC exists to clear the
      // queues, so restart the process to drop them. The session file is
      // durable JSONL and queued messages are not persisted, so nothing is
      // lost except the queued inputs themselves.
      console.warn("[Broadcast] Abort with pending Pi queues - restarting Pi RPC to drop queued messages");
      this.resetRunState();
      let restarted = false;
      try {
        await this.pi.reload();
        restarted = true;
        console.warn("[Broadcast] Pi RPC restarted after abort with pending queues");
      } catch (err) {
        console.error("[Broadcast] Pi RPC restart failed after abort:", err);
      }
      const message = restarted
        ? "Prompt aborted - queued steering/follow-up messages were cleared. Ready for a new message."
        : "Prompt aborted and queued messages were cleared, but Pi failed to restart. Restart the gateway before sending another message.";
      await this.broadcast(restarted ? await this.getState() : { type: "state", data: { isProcessing: false } });
      await this.broadcast({
        type: "abort_complete",
        data: {
          forced: false,
          restarted,
          message,
        },
      });
      return;
    }

    const escalation: { promise: Promise<void>; force: boolean } = {
      promise: Promise.resolve(),
      force: false,
    };
    this.abortEscalation = escalation;
    escalation.promise = this.runAbortEscalation(escalation).finally(() => {
      if (this.abortEscalation === escalation) this.abortEscalation = null;
    });

    await escalation.promise;
  }

  private async runAbortEscalation(ctx: { force: boolean }): Promise<void> {
    const settled = await this.waitForPromptSettle(this.abortGraceMs, () => ctx.force);
    if (settled) {
      await this.broadcast({ type: "state", data: { isProcessing: false } });
      await this.broadcast({
        type: "abort_complete",
        data: { forced: false, restarted: false, message: "Prompt aborted. Ready for a new message." },
      });
      return;
    }

    console.warn("[Broadcast] Abort did not settle the prompt in time - force-clearing");
    // Capture before forceRejectActivePrompt clears Pi's active-prompt state.
    const piStillBusy = this.pi.isPromptActive;
    this.currentPrompt = null;
    this.activeTurn = null;
    this.pi.forceRejectActivePrompt("Prompt aborted by user - stuck tool call was force-cleared");

    let restarted = false;
    if (piStillBusy) {
      console.warn("[Broadcast] Pi still busy after force-clear - restarting Pi RPC to kill stuck tool");
      try {
        await this.pi.reload();
        restarted = true;
        console.warn("[Broadcast] Pi RPC restarted successfully");
      } catch (err) {
        console.error("[Broadcast] Pi RPC restart failed:", err);
      }
    }
    let message = "Prompt aborted - the stuck run was force-cleared. Ready for a new message.";
    if (restarted) {
      message = "Prompt aborted - stuck tool call was stopped and Pi restarted. Ready for a new message.";
    } else if (piStillBusy) {
      message = "The stuck prompt was force-cleared, but Pi failed to restart. Restart the gateway before sending another message.";
    }
    await this.broadcast(restarted ? await this.getState() : { type: "state", data: { isProcessing: false } });
    await this.broadcast({
      type: "abort_complete",
      data: {
        forced: true,
        restarted,
        message,
      },
    });
  }

  private clearPendingQueues(): void {
    this.pendingSteering = [];
    this.pendingFollowUps = [];
  }

  private hasPendingQueues(): boolean {
    return this.pendingSteering.length > 0 || this.pendingFollowUps.length > 0;
  }

  /**
   * Clear all run-level state (active run, logical turn, pending queues).
   * Used by abort escalation, Pi exit handling, and the settle path.
   */
  private resetRunState(): void {
    this.activeTurn = null;
    this.currentPrompt = null;
    this.pendingSteering = [];
    this.pendingFollowUps = [];
    this.recentlySettledPending = [];
    this.lastPiQueueHadItems = false;
    this.lastSegmentUsage = undefined;
  }

  private async waitForPromptSettle(timeoutMs: number, shouldForceEarly?: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldForceEarly?.()) return false;
      if (!this.isPromptInFlight()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.isPromptInFlight();
  }

  isPromptInFlight(): boolean {
    return this.currentPrompt !== null || this.pi.isPromptActive;
  }

  hasRecentUserActivity(windowMs: number): boolean {
    if (this.lastUserActivityAt === 0) return false;
    return Date.now() - this.lastUserActivityAt < windowMs;
  }

  private async runTaskPrompt(input: {
    taskId: string;
    runId: string;
    taskName: string;
    prompt: string;
  }): Promise<string> {
    await this.waitForIdle();

    const clientIds = new Set(this.clients.keys());
    const turnId = this.resolveTurnId(input.runId, "task");
    this.currentPrompt = {
      message: input.prompt,
      turnId,
      clientIds,
      startedAt: Date.now(),
      originClientId: "task",
      origin: "task",
      taskId: input.taskId,
      taskRunId: input.runId,
      taskName: input.taskName,
    };
    this.activeTurn = { turnId, originClientId: "task" };

    console.log(
      `[Broadcast] Task prompt started (${input.taskId}, ${clientIds.size} client${clientIds.size === 1 ? "" : "s"}, chars=${input.prompt.length})`
    );

    try {
      return await this.pi.prompt(input.prompt, { source: "user", id: turnId });
    } catch (error) {
      const metadata = this.turnMetadata();
      this.resetRunState();
      await this.broadcast({
        type: "error",
        data: {
          message: error instanceof Error ? error.message : "Task prompt failed",
          ...metadata,
        },
      });
      throw error;
    }
  }

  private async waitForIdle(timeoutMs = 10 * 60 * 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.isPromptInFlight()) {
      if (Date.now() > deadline) {
        throw new Error(`waitForIdle timed out after ${timeoutMs / 1000}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  private turnMetadata():
    | {
        turnId: string;
        originClientId: string;
        origin?: "task";
        taskId?: string;
        taskRunId?: string;
        taskName?: string;
      }
    | Record<string, never> {
    const prompt = this.currentPrompt;
    if (!prompt) return {};
    const turn = this.activeTurn ?? { turnId: prompt.turnId, originClientId: prompt.originClientId };
    const metadata = {
      turnId: turn.turnId,
      originClientId: turn.originClientId,
    };
    if (prompt.origin !== "task" || !prompt.taskId || !prompt.taskRunId) return metadata;
    return { ...metadata, origin: "task", taskId: prompt.taskId, taskRunId: prompt.taskRunId, taskName: prompt.taskName };
  }

  private resolveTurnId(requestedTurnId: string | undefined, originClientId: string): string {
    const sanitized = requestedTurnId?.trim();
    if (sanitized) return sanitized;
    return `${originClientId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Extract concatenated text from an agent message's content field. */
  private agentMessageText(message: PiAgentMessage): string {
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }

  private setupPiListeners(): void {
    // Track accumulated text for the current logical turn
    let currentText = "";
    // Prose actually emitted to clients for this logical turn. Pi may finish a
    // message with text_done immediately before consuming a queued prompt;
    // text_done updates currentText but is not itself a streaming frame.
    let broadcastedText = "";
    let insideTool = false;
    let currentThinking = "";
    let currentThinkingId: string | null = null;
    let thinkingSeq = 0;
    const lastToolOutputById = new Map<string, string>();
    let eventQueue: Promise<void> = Promise.resolve();

    /** Reset per-logical-turn accumulation without touching run-level state. */
    const resetPerTurnAccumulation = (): void => {
      currentText = "";
      broadcastedText = "";
      currentThinking = "";
      currentThinkingId = null;
      thinkingSeq = 0;
      insideTool = false;
      lastToolOutputById.clear();
    };

    /** Full run-state reset (active run + pending queues + per-turn state). */
    const resetRunState = (): void => {
      resetPerTurnAccumulation();
      this.resetRunState();
    };

    const flushThinkingBlock = async (): Promise<void> => {
      if (!currentThinkingId) return;
      if (this.broadcastThinking) {
        await this.broadcast({
          type: "thinking_done",
          data: {
            thinkingId: currentThinkingId,
            content: currentThinking,
            seq: thinkingSeq,
            ...this.turnMetadata(),
          },
        });
      }
      currentThinking = "";
      currentThinkingId = null;
    };

    let suppressedEventsLogged = false;

    /**
     * Pi began a new low-level run (first run, retry, or continuation).
     * For a user run this means fresh per-turn accumulation.
     */
    const handleAgentStart = async (): Promise<void> => {
      await flushThinkingBlock();
      resetPerTurnAccumulation();
    };

    /**
     * One low-level run finished, but the session-level run may continue
     * (retry, compaction recovery, queued steering/follow-up). Extract usage
     * for accounting and log, but do NOT broadcast done or clear state here.
     */
    const handleAgentEnd = async (event: Extract<PiEvent, { type: "agent_end" }>): Promise<void> => {
      const usage = this.extractTokenUsage(event.messages);
      this.lastSegmentUsage = usage;
      if (usage) {
        this.cumulativeUsage.input += usage.input;
        this.cumulativeUsage.output += usage.output;
        this.cumulativeUsage.cacheRead += usage.cacheRead;
        this.cumulativeUsage.cacheWrite += usage.cacheWrite;
        this.cumulativeUsage.total += usage.total;
        if (usage.cost) this.cumulativeUsage.cost += usage.cost;
      }
      const completedPrompt = this.currentPrompt;
      const durationMs = completedPrompt ? Date.now() - completedPrompt.startedAt : undefined;
      const durationText = durationMs !== undefined ? ` | Duration: ${(durationMs / 1000).toFixed(1)}s` : "";
      if (usage) {
        console.log(
          `[Broadcast] Segment done: ${usage.total.toLocaleString()} tokens (in=${usage.input} out=${usage.output} cache=${usage.cacheRead}) $${(usage.cost ?? 0).toFixed(4)}${durationText} | Response chars: ${currentText.length}`
        );
      } else {
        console.log(`[Broadcast] Segment done: responseChars=${currentText.length}${durationText}`);
      }
    };

    /** Broadcast images embedded in prose as markdown, returning text-only prose. */
    const broadcastProseImages = async (prose: string): Promise<string> => {
      const imageExtractions = this.extractMarkdownImages(prose);
      for (const image of imageExtractions.images) {
        await this.broadcast({
          type: "image",
          data: {
            source: image.source,
            alt: image.alt,
            ...this.turnMetadata(),
          },
        });
      }
      return imageExtractions.textOnly;
    };

    /** Enrich segment usage with cumulative session totals. */
    const enrichUsage = (
      usage:
        | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number }
        | undefined
    ): TokenUsage | undefined => {
      if (!usage) return undefined;
      return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.total,
        cost: usage.cost,
        cumulative: {
          input: this.cumulativeUsage.input,
          output: this.cumulativeUsage.output,
          cacheRead: this.cumulativeUsage.cacheRead,
          cacheWrite: this.cumulativeUsage.cacheWrite,
          total: this.cumulativeUsage.total,
          cost: this.cumulativeUsage.cost || undefined,
        },
        contextTokens: usage.cacheRead + usage.input,
      };
    };

    /** Close the current logical response segment without marking the run idle. */
    const closeResponseSegment = async (): Promise<void> => {
      await flushThinkingBlock();
      const proseResponse = currentText;
      const usage = enrichUsage(this.lastSegmentUsage);
      const finalText = await broadcastProseImages(proseResponse);
      await broadcastMissingTextSuffix(finalText);
      await this.broadcast({
        type: "response_segment_done",
        data: { finalText, usage, ...this.turnMetadata() },
      });
      this.lastSegmentUsage = undefined;
      resetPerTurnAccumulation();
    };

    /**
     * Reconcile Pi's finalized prose with the deltas already sent to clients.
     * This preserves tool/prose ordering because only a trailing gap is safe to
     * append. Non-prefix differences are left to done.finalText-aware clients.
     */
    const broadcastMissingTextSuffix = async (finalText: string): Promise<void> => {
      if (
        !finalText ||
        finalText.includes("[[NO_ACTION]]") ||
        finalText.startsWith("[Heartbeat]") ||
        !finalText.startsWith(broadcastedText)
      ) {
        return;
      }

      const missingSuffix = finalText.slice(broadcastedText.length);
      if (!missingSuffix) return;

      console.warn(
        `[Broadcast] Repairing incomplete prose stream: emitted=${broadcastedText.length} final=${finalText.length}`
      );
      await this.broadcast({
        type: "text_delta",
        data: { content: missingSuffix, ...this.turnMetadata() },
      });
      broadcastedText = finalText;
    };

    /**
     * Pi began consuming a user message. Match it to a pending queue entry
     * (FIFO), close the previous response segment, and start a new logical
     * turn. Handles the race where a queued submission was started by Pi as a
     * fresh root prompt after settlement.
     */
    const handleUserMessageStart = async (event: Extract<PiEvent, { type: "message_start" }>): Promise<void> => {
      const text = this.agentMessageText(event.message);

      if (!this.currentPrompt) {
        // No active run: either a racing queued submission started as a root
        // prompt, or an unrecognized user message.
        const entry = this.takePendingForUserMessage(text);
        const recovered = entry ?? this.recoverRecentlySettled(text);
        if (recovered) {
          const clientIds = new Set(this.clients.keys());
          this.currentPrompt = {
            message: recovered.content,
            turnId: recovered.id,
            clientIds,
            startedAt: Date.now(),
            originClientId: recovered.originClientId,
            origin: "user",
          };
          this.activeTurn = { turnId: recovered.id, originClientId: recovered.originClientId };
          console.log(
            `[Broadcast] Queued submission started as new root prompt (from ${recovered.originClientId}, chars=${recovered.content.length})`
          );
          await this.broadcast({
            type: "user_message",
            data: { content: recovered.content, source: recovered.originClientId, id: recovered.id, ...this.turnMetadata() },
          });
          await this.broadcastQueueUpdate();
          return;
        }

        // Unrecognized user message (e.g. extension-injected). Render it as a
        // user row under a synthetic turn so clients stay consistent.
        const turnId = `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.currentPrompt = {
          message: text,
          turnId,
          clientIds: new Set(this.clients.keys()),
          startedAt: Date.now(),
          originClientId: "pi",
          origin: "user",
        };
        this.activeTurn = { turnId, originClientId: "pi" };
        console.log(`[Broadcast] Unknown user message_start (no pending match, chars=${text.length}) - rendering synthetic turn`);
        await this.broadcast({
          type: "user_message",
          data: { content: text, source: "pi", id: turnId, ...this.turnMetadata() },
        });
        return;
      }

      // Active run: if this is not a consumed queued message it is the root
      // prompt's own echo, which was already broadcast at submission.
      const entry = this.takePendingForUserMessage(text);
      if (!entry) return;

      // Close the previous logical response segment first, so clients can
      // finalize it before rendering the new user row.
      await closeResponseSegment();

      this.activeTurn = { turnId: entry.id, originClientId: entry.originClientId };
      console.log(
        `[Broadcast] Consumed queued ${entry.behavior} message (from ${entry.originClientId}, chars=${entry.content.length})`
      );
      await this.broadcast({
        type: "user_message",
        data: { content: entry.content, source: entry.originClientId, id: entry.id, ...this.turnMetadata() },
      });
      await this.broadcastQueueUpdate();
    };

    /** The session-level run is fully settled - finish and reset everything. */
    const handleAgentSettled = async (): Promise<void> => {
      await flushThinkingBlock();

      const completedPrompt = this.currentPrompt;
      const proseResponse = currentText;
      const usage = enrichUsage(this.lastSegmentUsage);
      const finalText = await broadcastProseImages(proseResponse);
      await broadcastMissingTextSuffix(finalText);

      if (completedPrompt) {
        const durationMs = Date.now() - completedPrompt.startedAt;
        console.log(
          `[Broadcast] Run settled: total ${this.cumulativeUsage.total.toLocaleString()} session tokens, duration ${(durationMs / 1000).toFixed(1)}s`
        );
      }

      await this.broadcast({
        type: "done",
        data: { finalText, usage, ...this.turnMetadata() },
      });

      // Preserve pending entries briefly so a queued submission that Pi
      // started as a fresh root prompt (submit/settle race) can be matched.
      const recentlySettled = this.hasPendingQueues()
        ? [...this.pendingSteering, ...this.pendingFollowUps].map((entry) => ({
            entry,
            clearedAt: Date.now(),
          }))
        : [];
      this.lastSegmentUsage = undefined;
      this.resetRunState();
      this.recentlySettledPending = recentlySettled;

      await this.broadcast({ type: "state", data: { isProcessing: false } });
    };

    const handlePiEvent = async (
      event: PiEvent,
      promptSource: "user" | "internal" | null
    ): Promise<void> => {
      if (promptSource !== "user") {
        // Log one line per suppressed turn block, not per event
        if (!suppressedEventsLogged) {
          suppressedEventsLogged = true;
          console.log(
            `[Broadcast] Suppressing events for non-user prompt (source=${promptSource ?? "unknown"})`
          );
        }
        if (event.type === "agent_settled") {
          currentThinking = "";
          currentThinkingId = null;
          lastToolOutputById.clear();
          insideTool = false;
          suppressedEventsLogged = false;
        }
        return;
      } else {
        // Reset flag when transitioning to a user prompt
        suppressedEventsLogged = false;
      }

      if (event.type === "agent_start") {
        await handleAgentStart();
        return;
      }

      if (event.type === "agent_end") {
        await handleAgentEnd(event);
        return;
      }

      if (event.type === "agent_settled") {
        await handleAgentSettled();
        return;
      }

      if (event.type === "message_start" && event.message.role === "user") {
        await handleUserMessageStart(event);
        return;
      }

      if (event.type === "queue_update") {
        this.lastPiQueueHadItems = event.steering.length > 0 || event.followUp.length > 0;
        const steeringDelta = this.pendingSteering.length - event.steering.length;
        const followUpDelta = this.pendingFollowUps.length - event.followUp.length;
        const awaitingConsumptionBoundary =
          (steeringDelta === 1 && followUpDelta === 0) ||
          (steeringDelta === 0 && followUpDelta === 1);
        if (
          !awaitingConsumptionBoundary &&
          (steeringDelta !== 0 || followUpDelta !== 0)
        ) {
          console.warn(
            `[Broadcast] Pi queue divergence: Pi steering=${event.steering.length} followUp=${event.followUp.length}, gateway steering=${this.pendingSteering.length} followUp=${this.pendingFollowUps.length}`
          );
        }
        return;
      }

      // Handle tool execution events
      if (event.type === "tool_execution_start") {
        // Pi may transition straight from thinking into a tool call without an explicit
        // thinking_done event. Close the active thinking block here so resumed reasoning
        // after the tool starts a fresh block below the tool lifecycle.
        await flushThinkingBlock();
        insideTool = true;

        const label = this.formatToolLabel(event.toolName || "tool", event.args);
        rememberToolLabel(event.toolCallId, label);

        await this.broadcast({
          type: "tool_start",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            args: event.args,
            label,
            ...this.turnMetadata(),
          },
        });

        // Create tool result block immediately so user can see live updates/abort context.
        await this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: "",
            truncated: false,
            ...this.turnMetadata(),
          },
        });
        lastToolOutputById.set(event.toolCallId, "");
      }

      if (event.type === "tool_execution_update") {
        const outputText = this.extractToolResultText(event.partialResult);
        const truncated = this.truncateToolOutput(outputText);
        const prev = lastToolOutputById.get(event.toolCallId) ?? "";

        if (truncated.text !== prev) {
          lastToolOutputById.set(event.toolCallId, truncated.text);
          await this.broadcast({
            type: "tool_output",
            data: {
              toolCallId: event.toolCallId,
              output: truncated.text,
              truncated: truncated.wasTruncated,
              ...this.turnMetadata(),
            },
          });
        }
      }

      if (event.type === "tool_execution_end") {
        const result = "result" in event ? (event as Record<string, unknown>).result : null;

        const images = this.extractImagesFromToolResult(result);
        for (const image of images) {
          await this.broadcast({
            type: "image",
            data: {
              source: image.source,
              alt: image.alt,
              ...this.turnMetadata(),
            },
          });
        }

        const outputText = this.extractToolResultText(result);
        const truncated = this.truncateToolOutput(outputText);

        await this.broadcast({
          type: "tool_output",
          data: {
            toolCallId: event.toolCallId,
            output: truncated.text,
            truncated: truncated.wasTruncated,
            ...this.turnMetadata(),
          },
        });
        lastToolOutputById.delete(event.toolCallId);

        await this.broadcast({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName || "tool",
            isError: event.isError,
            ...this.turnMetadata(),
          },
        });

        insideTool = false;
      }

      // Handle text streaming and thinking
      if (event.type === "message_update") {
        const msgEvent = event.assistantMessageEvent;

        if (msgEvent.type === "text_delta") {
          currentText += msgEvent.delta;

          // Skip heartbeat responses
          const delta = msgEvent.delta;
          if (delta.includes("[[NO_ACTION]]") || delta.startsWith("[Heartbeat]")) {
            // Heartbeat response - don't broadcast
          } else if (!insideTool) {
            // Only broadcast prose deltas (not tool output)
            await this.broadcast({
              type: "text_delta",
              data: { content: delta, ...this.turnMetadata() },
            });
            broadcastedText += delta;
          }
        }

        if (msgEvent.type === "text_done") {
          // Important: Use Pi's finalized text (can include corrected spacing/token joins)
          currentText = msgEvent.text;
        }

        if (msgEvent.type === "thinking_delta") {
          if (!currentThinkingId) {
            currentThinkingId = `thinking-${++thinkingSeq}`;
          }
          currentThinking += msgEvent.delta;
          // Skip heartbeat responses
          const delta = msgEvent.delta;
          if (
            this.broadcastThinking &&
            !delta.includes("[[NO_ACTION]]") &&
            !delta.startsWith("[Heartbeat]")
          ) {
            await this.broadcast({
              type: "thinking_delta",
              data: { thinkingId: currentThinkingId, content: delta, seq: thinkingSeq, ...this.turnMetadata() },
            });
          }
        }

        if (msgEvent.type === "thinking_done" && currentThinkingId) {
          await flushThinkingBlock();
        }
      }
    };

    // Rate limiting for events to prevent CPU spin.
    // Lifecycle events (agent_end, agent_settled, message_start) must never be
    // suppressed or the gateway enters a stuck state where currentPrompt is
    // never cleared or queued messages are never matched.
    const LIFECYCLE_EVENTS = new Set(["agent_end", "agent_settled", "message_start", "queue_update"]);
    let lastEventTime = 0;
    let eventCount = 0;
    const RATE_WINDOW_MS = 1000;
    const MAX_EVENTS_PER_WINDOW = 1000;

    this.pi.on("event", (event: PiEvent) => {
      const now = Date.now();
      if (now - lastEventTime > RATE_WINDOW_MS) {
        lastEventTime = now;
        eventCount = 0;
      }
      eventCount++;

      if (eventCount > MAX_EVENTS_PER_WINDOW && !LIFECYCLE_EVENTS.has(event.type)) {
        if (eventCount === MAX_EVENTS_PER_WINDOW + 1) {
          console.error("[Broadcast] Rate limit exceeded - suppressing non-lifecycle events");
        }
        return;
      }

      const promptSource = this.pi.promptSource;

      eventQueue = eventQueue
        .then(() =>
          Promise.race([
            handlePiEvent(event, promptSource),
            // Backstop: if a handler stalls (e.g. a hung client send), cap it so
            // the queue keeps moving and agent_settled can still be processed.
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`[Broadcast] Event handler timed out after ${this.eventHandlerTimeoutMs}ms: ${event.type}`)),
                this.eventHandlerTimeoutMs
              )
            ),
          ])
        )
        .catch((err) => {
          console.error("[Broadcast] Failed processing Pi event:", err);
          // If agent_settled itself was abandoned, the run state must still be
          // cleared or the gateway stays stuck on the previous prompt.
          if (event.type === "agent_settled") {
            console.warn("[Broadcast] agent_settled handler timed out - force-clearing run state");
            resetRunState();
          }
        });
    });
  }

  private formatToolLabel(toolName: string, args: unknown): string {
    const extractCommand = (value: unknown): string | null => {
      if (typeof value !== "object" || value === null) return null;
      const cmd = (value as Record<string, unknown>).command;
      return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
    };

    if (toolName === "bash") {
      const cmd = extractCommand(args);
      return cmd ? `$ ${cmd}` : "bash";
    }

    if (typeof args !== "object" || args === null) return toolName;
    const a = args as Record<string, unknown>;

    const pathLike =
      (typeof a.path === "string" && a.path) ||
      (typeof a.filePath === "string" && a.filePath) ||
      (typeof a.filename === "string" && a.filename);
    if (pathLike) return `${toolName} ${pathLike}`;

    const patternLike =
      (typeof a.pattern === "string" && a.pattern) ||
      (typeof a.glob === "string" && a.glob);
    if (patternLike) return `${toolName} ${patternLike}`;

    const urlLike = typeof a.url === "string" && a.url ? a.url : null;
    if (urlLike) return `${toolName} ${urlLike}`;

    const queryLike = typeof a.query === "string" && a.query ? a.query : null;
    if (queryLike) return `${toolName} ${queryLike}`;

    try {
      const json = JSON.stringify(args);
      const max = 140;
      return `${toolName} ${json.length > max ? json.slice(0, max - 1) + "…" : json}`;
    } catch {
      return toolName;
    }
  }

  private extractToolResultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (result === null || result === undefined) return "";
    if (Array.isArray(result)) {
      if (result.every((x) => typeof x === "string")) return (result as string[]).join("\n");
      return JSON.stringify(result, null, 2);
    }
    if (typeof result === "object") {
      const r = result as Record<string, unknown>;

      if (typeof r.text === "string") return r.text;
      if (typeof r.output === "string") return r.output;
      if (typeof r.stdout === "string") {
        let out = r.stdout;
        if (typeof r.stderr === "string" && r.stderr) out += "\n" + r.stderr;
        return out;
      }
      if (Array.isArray(r.paths) && r.paths.every((x) => typeof x === "string")) {
        return (r.paths as string[]).join("\n");
      }
      if (Array.isArray(r.matches) && r.matches.every((x) => typeof x === "string")) {
        return (r.matches as string[]).join("\n");
      }
      if (Array.isArray(r.content)) {
        const textParts = r.content
          .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).text : null))
          .filter((value): value is string => typeof value === "string");
        if (textParts.length > 0) return textParts.join("\n");
        return "";
      }

      return JSON.stringify(result, null, 2);
    }
    return String(result);
  }

  private truncateToolOutput(text: string): { text: string; wasTruncated: boolean } {
    const maxChars = 1800;
    const maxLines = 30;
    
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return { text: "", wasTruncated: false };

    let out = normalized;
    let wasTruncated = false;

    const lines = normalized.split("\n");
    if (lines.length > maxLines) {
      out = lines.slice(0, maxLines).join("\n") + "\n… (truncated)";
      wasTruncated = true;
    }

    if (out.length > maxChars) {
      const truncated = out.slice(0, maxChars);
      const lastNewline = truncated.lastIndexOf("\n");
      const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
      out = out.slice(0, cutPoint) + "\n… (truncated)";
      wasTruncated = true;
    }

    return { text: out, wasTruncated };
  }

  private extractImagesFromToolResult(result: unknown): Array<{ source: string; alt?: string }> {
    if (!result || typeof result !== "object") return [];
    const r = result as Record<string, unknown>;
    const content = r.content;
    if (!Array.isArray(content)) return [];

    const images: Array<{ source: string; alt?: string }> = [];

    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type !== "image") continue;

      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      const base64 = typeof part.data === "string" ? part.data : null;
      if (base64 && base64.length > 0) {
        images.push({
          source: `data:${mimeType};base64,${base64}`,
          alt: "Generated image",
        });
      }
    }

    return images;
  }

  private extractMarkdownImages(text: string): { textOnly: string; images: Array<{ source: string; alt?: string }> } {
    const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const images: Array<{ source: string; alt?: string }> = [];

    const textOnly = text.replace(regex, (_, alt: string, source: string) => {
      const cleanSource = source.trim();
      if (cleanSource) {
        images.push({
          source: cleanSource,
          alt: alt?.trim() || undefined,
        });
      }
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();

    return { textOnly, images };
  }

  private extractTokenUsage(messages: unknown[] | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost?: number } | undefined {
    if (!messages || !Array.isArray(messages)) {
      return undefined;
    }

    // Find the last assistant message with usage data
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          total?: number;
          totalTokens?: number;
          cost?: { total?: number } | number
        }
      };
      if (msg.role === "assistant" && msg.usage) {
        const usage = msg.usage;
        // Handle different cost formats (number or { total: number })
        let costValue: number | undefined;
        if (typeof usage.cost === "number") {
          costValue = usage.cost;
        } else if (usage.cost && typeof usage.cost === "object") {
          costValue = usage.cost.total;
        }
        return {
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
          total: usage.total ?? usage.totalTokens ?? ((usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)),
          cost: costValue,
        };
      }
    }
    return undefined;
  }

  /**
   * Listen for Pi process exit so we can clear state instead of getting stuck.
   */
  private setupPiExitHandler(): void {
    this.pi.on("exit", (code) => {
      if (this.currentPrompt) {
        console.warn(
          `[Broadcast] Pi process exited (code=${code}) with active prompt - clearing state and notifying clients`
        );
        const metadata = this.turnMetadata();
        this.resetRunState();
        this.broadcast({
          type: "error",
          data: { message: "Assistant process exited - please start a new session", ...metadata },
        }).catch(() => {});
        this.broadcast({ type: "state", data: { isProcessing: false } }).catch(() => {});
      }
    });
  }

  // MARK: - Slash Command Handlers

  async handleModelCommand(args: string): Promise<string> {
    const arg = args.trim();

    // No args - show current model
    if (!arg) {
      const state = await this.pi.getState();
      const stateData = state.data as { model?: { id: string; provider: string; name: string } } | undefined;
      const model = stateData?.model;
      return model 
        ? `Current model: ${model.provider}/${model.id} (${model.name})`
        : "Current model: (unknown)";
    }

    // List available models
    if (arg === "list") {
      const models = await this.getAvailableModels();

      const state = await this.pi.getState();
      const stateData = state.data as { model?: { id: string; provider: string } } | undefined;
      const currentModel = stateData?.model;

      const lines = models.map((m, i) => {
        const prefix = currentModel?.provider === m.provider && currentModel?.id === m.id ? "> " : "  ";
        return `${prefix}${i + 1}. ${m.provider}/${m.id} (${m.name})`;
      });

      return ["Available models:", ...lines].join("\n");
    }

    // Switch to model by number
    const index = parseInt(arg, 10);
    if (isNaN(index) || index < 1) {
      return "Invalid number. Use /model list to see available models.";
    }

    const models = await this.getAvailableModels();

    if (index > models.length) {
      return `Model ${index} not found. Use /model list to see available models (1-${models.length}).`;
    }

    const selected = models[index - 1];

    const result = await this.switchModel(selected.provider, selected.id);
    if (result.success) {
      return `Model changed to ${selected.provider}/${selected.id} (${selected.name})`;
    }
    return `Failed to set model: ${result.error ?? "Unknown error"}`;
  }

  /**
   * Get list of available models for WebSocket clients
   */
  async getAvailableModels(): Promise<WSModelInfo[]> {
    const response = await this.pi.getAvailableModels();
    if (!response.success || !response.data) {
      return [];
    }
    const data = response.data as { models?: PiModelInfo[] };
    return (data.models ?? []).map(toWSModelInfo);
  }

  async getThinkingLevels(): Promise<{
    levels: ThinkingLevel[];
    current: ThinkingLevel;
    model?: WSModelInfo;
  }> {
    const stateResponse = await this.pi.getState();
    if (!stateResponse.success) {
      throw new Error(stateResponse.error ?? "Failed to get Pi state");
    }
    const stateData = stateResponse.data as PiState | undefined;
    const levelsResponse = await this.pi.getAvailableThinkingLevels();
    if (!levelsResponse.success) {
      throw new Error(levelsResponse.error ?? "Failed to get thinking levels");
    }
    const levelsData = levelsResponse.data as { levels?: unknown[] } | undefined;
    const levels = (levelsData?.levels ?? []).filter(isThinkingLevel);
    if (levels.length === 0) {
      throw new Error("Pi returned no thinking levels for the current model");
    }
    return {
      levels,
      current: isThinkingLevel(stateData?.thinkingLevel) ? stateData.thinkingLevel : "off",
      model: stateData?.model ? toWSModelInfo(stateData.model) : undefined,
    };
  }

  setThinkingLevel(level: ThinkingLevel): Promise<{
    success: boolean;
    requestedLevel: ThinkingLevel;
    level?: ThinkingLevel;
    availableLevels?: ThinkingLevel[];
    model?: WSModelInfo;
    error?: string;
  }> {
    return this.enqueueControl(async () => {
      try {
        const before = await this.getThinkingLevels();
        if (!before.levels.includes(level)) {
          return {
            success: false,
            requestedLevel: level,
            availableLevels: before.levels,
            model: before.model,
            error: `${level} is not supported by ${before.model ? `${before.model.provider}/${before.model.id}` : "the current model"}`,
          };
        }

        await this.pi.setThinkingLevel(level);
        const state = await this.getState();
        await this.broadcast(state);
        return {
          success: true,
          requestedLevel: level,
          level: state.data.thinkingLevel ?? level,
          availableLevels: state.data.availableThinkingLevels,
          model: state.data.model,
        };
      } catch (err) {
        return {
          success: false,
          requestedLevel: level,
          error: err instanceof Error ? err.message : "Failed to set thinking level",
        };
      }
    });
  }

  /**
   * Switch to a specific model by provider and id
   */
  switchModel(provider: string, modelId: string): Promise<{ success: boolean; model?: WSModelInfo; error?: string }> {
    return this.enqueueControl(async () => {
      try {
        // Get available models to validate and get name/capabilities.
        const models = await this.getAvailableModels();
        const model = models.find(m => m.provider === provider && m.id === modelId);

        if (!model) {
          return { success: false, error: `Model ${provider}/${modelId} not found` };
        }

        await this.pi.setModelViaRpc(provider, modelId);
        const state = await this.getState();
        const effectiveModel = state.data.model ?? model;

        await this.broadcast({
          type: "model_switched",
          data: { success: true, model: effectiveModel },
        });
        // Pi can clamp thinking when the model changes; synchronize the
        // authoritative post-switch state to every client.
        await this.broadcast(state);

        return { success: true, model: effectiveModel };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Failed to switch model",
        };
      }
    });
  }

  private enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.controlQueue.then(operation, operation);
    this.controlQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async handleSessionCommand(): Promise<string> {
    const state = await this.pi.getState();
    const stateData = state.data as { 
      model?: { id: string; provider: string; name?: string };
      contextWindow?: number;
      compactThreshold?: number;
    } | undefined;
    
    const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
    
    const lines: string[] = [];
    
    // Get current token usage from session file
    let currentTokens = 0;
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(this.sessionManager?.['sessionPath'] || "", "utf-8");
      const lines = content.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) {
          const u = entry.message.usage;
          currentTokens = (u.cacheRead ?? 0) + (u.inputTokens ?? 0);
          break;
        }
      }
    } catch (err) {
      // ignore
    }
    
    if (stateData?.model) {
      lines.push(`**Model:** ${stateData.model.provider}/${stateData.model.id}`);
    }
    
    if (stateData?.contextWindow) {
      lines.push(`**Context Window:** ${fmt(stateData.contextWindow)} tokens`);
    }
    
    if (stateData?.compactThreshold) {
      lines.push(`**Compact Threshold:** ${fmt(stateData.compactThreshold)} tokens`);
      if (currentTokens > 0) {
        const pct = Math.min(100, Math.round((currentTokens / stateData.compactThreshold) * 100));
        lines.push(`**Current Usage:** ${fmt(currentTokens)} tokens (${pct}%)`);
        if (pct >= 90) {
          lines.push(`⚠️ **Compaction imminent** - context approaching threshold`);
        } else if (pct >= 75) {
          lines.push(`⚡ **Compaction approaching** - consider starting fresh soon`);
        }
      }
    }
    
    // Compaction count
    const compactionCount = this.sessionManager?.['compactionCount'] ?? 0;
    lines.push(`**Compactions this session:** ${compactionCount}`);
    
    return lines.length > 0 ? lines.join("\n") : "Session info unavailable";
  }
  
  /**
   * Get detailed session status for WebSocket clients
   */
  async getSessionStatus(): Promise<{
    model?: { provider: string; id: string; name?: string };
    contextWindow?: number;
    compactThreshold?: number;
    currentTokens: number;
    percentage: number;
    compactionCount: number;
  }> {
    const state = await this.pi.getState();
    const stateData = state.data as { 
      model?: { id: string; provider: string; name?: string };
      contextWindow?: number;
      compactThreshold?: number;
    } | undefined;
    
    // Get current token usage from session file
    const currentTokens = (await this.readCurrentContextTokensFromSession()) ?? 0;
    
    const compactThreshold = stateData?.compactThreshold ?? 0;
    const percentage = compactThreshold > 0 
      ? Math.min(100, Math.round((currentTokens / compactThreshold) * 100))
      : 0;
    
    return {
      model: stateData?.model,
      contextWindow: stateData?.contextWindow,
      compactThreshold,
      currentTokens,
      percentage,
      compactionCount: this.sessionManager?.['compactionCount'] ?? 0,
    };
  }

  async handleNewCommand(): Promise<string> {
    if (!this.sessionManager) {
      return "❌ Session manager not available. Please restart the gateway.";
    }

    const result = await this.sessionManager.archiveAndStartNew();

    // Reset cumulative usage for new session
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

    if (result.error) {
      return `❌ Failed to start new session: ${result.error}`;
    }

    // switch_session can change the effective model, thinking level, context
    // window, and usage. Broadcast Pi's authoritative post-switch state now;
    // clients must not retain metadata from the archived session.
    const state = await this.getState();
    state.data.contextTokens = 0;
    await this.broadcast(state);

    return [
      `✅ New session started`,
      ``,
      `Archived: ${result.archived}`,
    ].join("\n");
  }

  }
