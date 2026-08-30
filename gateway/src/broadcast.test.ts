import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BroadcastManager, thinkingLevelsForModel } from "./broadcast.js";
import type { PiRpcClient } from "./pi-rpc.js";
import type { PiEvent, ThinkingLevel } from "./types.js";
import type { Client, WSServerMessage } from "./types-ws.js";

/** Captures everything a connected client receives. */
class FakeClient implements Client {
  id: string;
  type = "websocket" as const;
  sent: WSServerMessage[] = [];
  constructor(id: string) {
    this.id = id;
  }
  send(message: WSServerMessage): void {
    this.sent.push(message);
  }
  isAvailable(): boolean {
    return true;
  }
  sentTypes(): string[] {
    return this.sent.map((m) => m.type);
  }
  lastOf<T extends WSServerMessage["type"]>(type: T): Extract<WSServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i] as Extract<WSServerMessage, { type: T }>;
    }
    return undefined;
  }
}

/** Fake Pi RPC client for driving BroadcastManager without a real process. */
class FakePi extends EventEmitter {
  promptSource: "user" | "internal" | null = null;
  isPromptActive = false;
  promptCalls: Array<{ message: string; options?: { source?: string; id?: string } }> = [];
  submitCalls: Array<{
    message: string;
    behavior: "steer" | "followUp";
    options?: { source?: string; id?: string; images?: { data: string; mimeType: string }[] };
  }> = [];
  submitError: Error | null = null;
  abortCalls = 0;
  reloadCalls = 0;
  forceRejectCalls = 0;
  stateData: unknown = { model: null, thinkingLevel: "off" };
  availableThinkingLevels: ThinkingLevel[] = ["off"];
  thinkingLevelCalls: ThinkingLevel[] = [];
  extensionUiResponses: unknown[] = [];

  async prompt(message: string, options?: { source?: string; id?: string }): Promise<string> {
    this.promptCalls.push({ message, options });
    // Mirror pi-rpc: promptSource reflects the ACTIVE prompt's source. A user
    // prompt queued behind internal work does not flip it.
    if (this.promptSource === null) this.promptSource = "user";
    this.isPromptActive = true;
    return new Promise(() => {}); // resolves via events in real flow; tests settle manually
  }

  async promptWithImages(
    message: string,
    images: { data: string; mimeType: string }[],
    options?: { source?: string; id?: string }
  ): Promise<string> {
    this.promptCalls.push({ message, options });
    if (this.promptSource === null) this.promptSource = "user";
    this.isPromptActive = true;
    void images;
    return new Promise(() => {});
  }

  async submitDuringRun(
    message: string,
    behavior: "steer" | "followUp",
    options?: { source?: string; id?: string; images?: { data: string; mimeType: string }[] }
  ): Promise<{ type: "response"; id?: string; command: string; success: boolean; error?: string }> {
    this.submitCalls.push({ message, behavior, options });
    if (this.submitError) throw this.submitError;
    return { type: "response", command: "prompt", success: true };
  }

  abort(): void {
    this.abortCalls++;
  }

  forceRejectActivePrompt(_reason: string): void {
    this.forceRejectCalls++;
    this.isPromptActive = false;
    this.promptSource = null;
  }

  async reload(): Promise<void> {
    this.reloadCalls++;
    this.isPromptActive = false;
    this.promptSource = null;
  }

  async getState(): Promise<{ type: "response"; command: string; success: boolean; data?: unknown }> {
    return { type: "response", command: "get_state", success: true, data: this.stateData };
  }

  async getAvailableModels(): Promise<{ type: "response"; command: string; success: boolean; data?: unknown }> {
    return { type: "response", command: "get_available_models", success: true, data: { models: [] } };
  }

  async getAvailableThinkingLevels(): Promise<{ type: "response"; command: string; success: boolean; data?: unknown }> {
    return {
      type: "response",
      command: "get_available_thinking_levels",
      success: true,
      data: { levels: this.availableThinkingLevels },
    };
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.thinkingLevelCalls.push(level);
    this.stateData = { ...(this.stateData as object), thinkingLevel: level };
  }

  respondToExtensionUi(payload: unknown): void {
    this.extensionUiResponses.push(payload);
  }

  emitPiEvent(event: PiEvent): void {
    this.emit("event", event);
  }

  /** Settle the current run exactly as Pi would: agent_end then agent_settled. */
  settleRun(finalText = ""): void {
    if (finalText) {
      this.emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: finalText } });
    }
    this.emitPiEvent({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0 },
        },
      ],
    });
    this.emitPiEvent({ type: "agent_settled" });
    // Mirror pi-rpc clearing its active-prompt state on agent_settled.
    this.isPromptActive = false;
    this.promptSource = null;
  }
}

function userMessageStart(text: string): PiEvent {
  return {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

async function flushEvents(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function setup(pi?: FakePi): { manager: BroadcastManager; pi: FakePi; clientA: FakeClient; clientB: FakeClient } {
  const fakePi = pi ?? new FakePi();
  const manager = new BroadcastManager(fakePi as unknown as PiRpcClient, {
    abortGraceMs: 50,
  });
  const clientA = new FakeClient("client-a");
  const clientB = new FakeClient("client-b");
  manager.registerClient(clientA);
  manager.registerClient(clientB);
  return { manager, pi: fakePi, clientA, clientB };
}

describe("BroadcastManager state", () => {
  it("broadcasts authoritative model and zero context after a new session", async () => {
    const pi = new FakePi();
    pi.stateData = {
      model: {
        provider: "opencode-go",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextWindow: 1_000_000,
        reasoning: true,
      },
      thinkingLevel: "high",
    };
    pi.availableThinkingLevels = ["off", "high"];
    const { manager, clientA } = setup(pi);
    manager.setSessionManager({
      archiveAndStartNew: async () => ({ archived: "/tmp/archive.jsonl" }),
    } as never);

    await manager.handleNewCommand();

    expect(clientA.lastOf("state")?.data).toMatchObject({
      model: { provider: "opencode-go", id: "deepseek-v4-pro" },
      contextTokens: 0,
      thinkingLevel: "high",
      isProcessing: false,
    });
  });

  it("acknowledges a root prompt to its submitting client", async () => {
    const { manager, clientA, clientB } = setup();

    await manager.sendPrompt("hello", "client-a", "root-id");

    expect(clientA.lastOf("prompt_accepted")?.data).toEqual({
      id: "root-id",
      content: "hello",
      originClientId: "client-a",
    });
    expect(clientB.sentTypes()).not.toContain("prompt_accepted");
  });

  it("preserves Pi's thinking level in the WebSocket state", async () => {
    const pi = new FakePi();
    pi.stateData = { model: null, thinkingLevel: "xhigh" };
    const { manager } = setup(pi);

    const state = await manager.getState();

    expect(state.data.thinkingLevel).toBe("xhigh");
  });

  it("derives model-specific thinking levels using Pi's mapping rules", () => {
    expect(thinkingLevelsForModel({ reasoning: false })).toEqual(["off"]);
    expect(thinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
    })).toEqual(["off", "high", "max"]);
    expect(thinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    })).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("sets a supported thinking level and broadcasts canonical state", async () => {
    const pi = new FakePi();
    pi.availableThinkingLevels = ["off", "high", "max"];
    pi.stateData = { model: null, thinkingLevel: "off" };
    const { manager, clientA, clientB } = setup(pi);

    const result = await manager.setThinkingLevel("high");

    expect(result).toMatchObject({ success: true, level: "high" });
    expect(pi.thinkingLevelCalls).toEqual(["high"]);
    expect(clientA.lastOf("state")?.data.thinkingLevel).toBe("high");
    expect(clientB.lastOf("state")?.data.thinkingLevel).toBe("high");
  });

  it("rejects unsupported thinking levels without relying on Pi clamping", async () => {
    const pi = new FakePi();
    pi.availableThinkingLevels = ["off", "high", "max"];
    const { manager } = setup(pi);

    const result = await manager.setThinkingLevel("medium");

    expect(result).toMatchObject({ success: false, requestedLevel: "medium" });
    expect(result.availableLevels).toEqual(["off", "high", "max"]);
    expect(pi.thinkingLevelCalls).toEqual([]);
  });
});

describe("BroadcastManager steering/follow-up", () => {
  it("idle prompt starts a root prompt unchanged", async () => {
    const { manager, pi, clientA, clientB } = setup();

    const clients = await manager.sendPrompt("hello", "client-a");

    expect(clients.size).toBe(2);
    expect(pi.promptCalls).toHaveLength(1);
    expect(pi.promptCalls[0].message).toBe("hello");
    // Origin client already rendered its message; others receive user_message.
    expect(clientA.sentTypes()).not.toContain("user_message");
    expect(clientB.sentTypes()).toContain("user_message");
  });

  it("busy prompt defaults to steering and is not rejected", async () => {
    const { manager, pi, clientA, clientB } = setup();

    await manager.sendPrompt("do a thing", "client-a");
    await manager.sendPrompt("actually do this instead", "client-b");

    expect(pi.submitCalls).toHaveLength(1);
    expect(pi.submitCalls[0]).toMatchObject({ message: "actually do this instead", behavior: "steer" });
    // Only one root prompt ever started.
    expect(pi.promptCalls).toHaveLength(1);

    // Origin client got the acknowledgement; everyone got a queue update.
    expect(clientB.lastOf("prompt_queued")?.data).toMatchObject({ behavior: "steer" });
    expect(clientA.lastOf("queue_update")?.data.steering).toHaveLength(1);
    expect(clientB.lastOf("queue_update")?.data.steering).toHaveLength(1);
  });

  it("explicit followUp sends streamingBehavior followUp", async () => {
    const { manager, pi } = setup();

    await manager.sendPrompt("base", "client-a");
    await manager.sendPrompt("after you finish, summarize", "client-a", undefined, "followUp");

    expect(pi.submitCalls[0].behavior).toBe("followUp");
  });

  it("busy submission bypasses the prompt FIFO", async () => {
    const { manager, pi } = setup();

    await manager.sendPrompt("root", "client-a");
    await manager.sendPrompt("steer one", "client-a");
    await manager.sendPrompt("steer two", "client-a");

    expect(pi.promptCalls).toHaveLength(1);
    expect(pi.submitCalls).toHaveLength(2);
  });

  it("Pi rejection removes pending metadata and returns a targeted error", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("root", "client-a");
    pi.submitError = new Error("Extension command cannot be queued");
    await expect(manager.sendPrompt("/bad-ext", "client-b")).rejects.toThrow(
      "Extension command cannot be queued"
    );

    // Pending queue is empty again; no acknowledgement was sent.
    expect(clientB.sentTypes()).not.toContain("prompt_queued");
    expect(clientB.lastOf("queue_update")?.data.steering).toEqual([]);
  });

  it("consumed queued message closes the segment, switches turns, and routes deltas", async () => {
    const { manager, pi, clientA, clientB } = setup();

    await manager.sendPrompt("root question", "client-a");
    await manager.sendPrompt("steer me", "client-b", "steer-turn-id");

    // First segment streams.
    pi.emitPiEvent({ type: "agent_start" });
    pi.emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first answer" } });
    await flushEvents();
    expect(clientB.lastOf("text_delta")?.data.content).toBe("first answer");

    // Pi consumes the steering message.
    pi.emitPiEvent(userMessageStart("steer me"));
    await flushEvents();

    // Segment closed with the first turn's text and id.
    const segmentDone = clientB.lastOf("response_segment_done");
    expect(segmentDone?.data.finalText).toBe("first answer");

    // The user row was broadcast to all clients (origin had only a pending indicator).
    const userRow = clientB.lastOf("user_message");
    expect(userRow?.data).toMatchObject({ content: "steer me", source: "client-b", id: "steer-turn-id" });
    expect(clientA.lastOf("user_message")?.data.content).toBe("steer me");

    // Deltas now route under the new turn id.
    pi.emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "steered answer" } });
    await flushEvents();
    const delta = clientB.lastOf("text_delta");
    expect(delta?.data.content).toBe("steered answer");
    expect(delta?.data.turnId).toBe("steer-turn-id");

    // Queue is empty after consumption.
    expect(clientB.lastOf("queue_update")?.data.steering).toEqual([]);
  });

  it("broadcasts finalized text missing at a queued-message boundary", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("root question", "client-a", "root-turn");
    await manager.sendPrompt("steer me", "client-b", "steer-turn");
    pi.emitPiEvent({ type: "agent_start" });

    // Some providers can finalize the assistant message without delivering
    // matching text_delta frames immediately before Pi consumes steering.
    pi.emitPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_done", text: "complete original answer" },
    });
    pi.emitPiEvent(userMessageStart("steer me"));
    await flushEvents();

    const types = clientB.sentTypes();
    const repairedTextIndex = types.lastIndexOf("text_delta");
    const segmentDoneIndex = types.lastIndexOf("response_segment_done");
    const consumedUserIndex = types.lastIndexOf("user_message");
    expect(repairedTextIndex).toBeGreaterThanOrEqual(0);
    expect(repairedTextIndex).toBeLessThan(segmentDoneIndex);
    expect(segmentDoneIndex).toBeLessThan(consumedUserIndex);
    expect(clientB.lastOf("text_delta")?.data).toMatchObject({
      content: "complete original answer",
      turnId: "root-turn",
    });
  });

  it("duplicate queued texts are matched FIFO with distinct ids", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("root", "client-a");
    await manager.sendPrompt("same text", "client-b", "dup-1");
    await manager.sendPrompt("same text", "client-b", "dup-2");

    pi.emitPiEvent(userMessageStart("same text"));
    await flushEvents();
    expect(clientB.lastOf("user_message")?.data.id).toBe("dup-1");
    expect(clientB.lastOf("queue_update")?.data.steering).toHaveLength(1);

    pi.emitPiEvent(userMessageStart("same text"));
    await flushEvents();
    expect(clientB.lastOf("user_message")?.data.id).toBe("dup-2");
    expect(clientB.lastOf("queue_update")?.data.steering).toHaveLength(0);
  });

  it("agent_end does not clear busy state or emit done", async () => {
    const { manager, pi, clientB } = setup();
    await manager.sendPrompt("root", "client-a");
    pi.emitPiEvent({ type: "agent_start" });

    pi.emitPiEvent({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      ],
    });
    await flushEvents();

    expect(manager.isPromptInFlight()).toBe(true);
    expect(clientB.sentTypes()).not.toContain("done");
  });

  it("agent_settled emits done, clears busy state, and empties queues", async () => {
    const { manager, pi, clientA, clientB } = setup();
    await manager.sendPrompt("root", "client-a");
    pi.emitPiEvent({ type: "agent_start" });
    pi.emitPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "final answer" } });
    pi.emitPiEvent({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0 },
        },
      ],
    });
    pi.emitPiEvent({ type: "agent_settled" });
    pi.isPromptActive = false;
    pi.promptSource = null;
    await flushEvents();

    const done = clientB.lastOf("done");
    expect(done?.data.finalText).toBe("final answer");
    expect(done?.data.usage?.input).toBe(10);
    expect(done?.data.usage?.cumulative?.output).toBe(20);
    expect(manager.isPromptInFlight()).toBe(false);
    expect(clientB.lastOf("state")?.data.isProcessing).toBe(false);

    // A new prompt after settle starts a fresh root.
    pi.promptSource = null;
    await manager.sendPrompt("next", "client-a");
    expect(pi.promptCalls).toHaveLength(2);
  });

  it("steering during a tool call is accepted and delivered only at Pi's boundary", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("run a long tool", "client-a");
    pi.emitPiEvent({ type: "agent_start" });
    pi.emitPiEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });

    // Steering submitted while the tool is active: accepted immediately, not
    // injected into the transcript yet.
    await manager.sendPrompt("please stop the tool work", "client-b");
    expect(pi.submitCalls).toHaveLength(1);
    const userMessagesBeforeBoundary = clientB.sent.filter((m) => m.type === "user_message");
    expect(userMessagesBeforeBoundary.map((m) => m.data.content)).not.toContain("please stop the tool work");
  });

  it("submit/settle race starts the queued message as a new root prompt", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("root", "client-a");
    await manager.sendPrompt("raced steering", "client-b", "race-id");

    // The old run settles first (Pi started the steering as a new root prompt).
    pi.settleRun("root answer");
    await flushEvents();

    // New run begins with the raced message. Real pi-rpc marks this as a user
    // run via its pending submitDuringRun flag (activePromptSource was null).
    pi.promptSource = "user";
    pi.isPromptActive = true;
    pi.emitPiEvent({ type: "agent_start" });
    pi.emitPiEvent(userMessageStart("raced steering"));
    await flushEvents();

    const userRow = clientB.lastOf("user_message");
    expect(userRow?.data).toMatchObject({ content: "raced steering", source: "client-b", id: "race-id" });
    expect(manager.isPromptInFlight()).toBe(true);
  });

  it("image steering preserves attachments", async () => {
    const { manager, pi } = setup();

    await manager.sendPrompt("root", "client-a");
    await manager.sendPromptWithImages(
      "what about this image?",
      [{ data: "aGVsbG8=", mimeType: "image/png" }],
      "client-b",
      "img-steer-id"
    );

    expect(pi.submitCalls).toHaveLength(1);
    expect(pi.submitCalls[0].options?.images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
  });

  it("steers an unclaimed Pi user run (racing root window)", async () => {
    const { manager, pi } = setup();
    // Pi is running a racing-root user run the gateway has not claimed yet.
    pi.isPromptActive = true;
    pi.promptSource = "user";

    await manager.sendPrompt("redirect the racer", "client-a");

    expect(pi.submitCalls).toHaveLength(1);
    expect(pi.submitCalls[0].behavior).toBe("steer");
    expect(pi.promptCalls).toHaveLength(0);
  });

  it("internal work cannot be steered by a user prompt", async () => {
    const { manager, pi } = setup();
    pi.promptSource = "internal";
    pi.isPromptActive = true;

    await manager.sendPrompt("user message during heartbeat", "client-a");

    // The user prompt queues behind the internal one as a root (existing
    // behavior); a second submission would be steering and must be rejected.
    await expect(manager.sendPrompt("steer attempt", "client-a")).rejects.toThrow(/internal work/);
    expect(pi.submitCalls).toHaveLength(0);
  });

  it("abort clears active and pending state once, restarting Pi when queues were pending", async () => {
    const { manager, pi, clientB } = setup();

    await manager.sendPrompt("root", "client-a");
    await manager.sendPrompt("pending steer", "client-b");
    pi.emitPiEvent({ type: "queue_update", steering: ["pending steer"], followUp: [] });
    await flushEvents();

    await manager.abort();

    expect(pi.abortCalls).toBe(1);
    // Pi's queues cannot be cleared via RPC, so the process is restarted.
    expect(pi.reloadCalls).toBe(1);
    expect(manager.isPromptInFlight()).toBe(false);
    expect(clientB.lastOf("queue_update")?.data).toEqual({ steering: [], followUp: [] });
    expect(clientB.lastOf("state")?.data.isProcessing).toBe(false);
    expect(clientB.lastOf("abort_complete")?.data).toMatchObject({ forced: false, restarted: true });

    // Abort again while idle only resynchronizes clients; Pi is untouched.
    await manager.abort();
    expect(pi.abortCalls).toBe(1);
    expect(pi.reloadCalls).toBe(1);
  });

  it("abort without pending queues settles through the normal path", async () => {
    const { manager, pi, clientB } = setup();
    await manager.sendPrompt("root", "client-a");
    pi.emitPiEvent({ type: "agent_start" });

    const abortPromise = manager.abort();
    expect(pi.abortCalls).toBe(1);

    // Pi settles on its own after abort.
    pi.settleRun("partial answer");
    await abortPromise;

    expect(pi.reloadCalls).toBe(0);
    expect(pi.forceRejectCalls).toBe(0);
    expect(manager.isPromptInFlight()).toBe(false);
    expect(clientB.lastOf("state")?.data.isProcessing).toBe(false);
    expect(clientB.lastOf("abort_complete")?.data).toMatchObject({ forced: false, restarted: false });
  });

  it("abort escalates to force-clear when Pi does not settle", async () => {
    const { manager, pi, clientB } = setup();
    await manager.sendPrompt("stuck", "client-a");
    pi.emitPiEvent({ type: "agent_start" });

    // Pi ignores the abort: nothing settles.
    const abortPromise = manager.abort();
    await abortPromise;

    expect(pi.forceRejectCalls).toBe(1);
    expect(pi.reloadCalls).toBe(1); // stuck tool => process restart
    expect(manager.isPromptInFlight()).toBe(false);
    expect(clientB.lastOf("state")?.data.isProcessing).toBe(false);
    expect(clientB.lastOf("abort_complete")?.data).toMatchObject({ forced: true, restarted: true });
  });

  it("recovers a stale busy client after force-abort without duplicating its next root prompt", async () => {
    const { manager, pi, clientA } = setup();
    await manager.sendPrompt("stuck", "client-a", "stuck-id");
    pi.emitPiEvent({ type: "agent_start" });

    await manager.abort();
    expect(clientA.lastOf("state")?.data.isProcessing).toBe(false);

    // Model the incident: the client still includes a stale busy-time steer
    // hint. An idle gateway must start exactly one root and acknowledge it by
    // id so the client can clear the retained composer text.
    await manager.sendPrompt("Test 123", "client-a", "test-id", "steer");

    expect(pi.promptCalls).toHaveLength(2);
    expect(pi.submitCalls).toHaveLength(0);
    expect(clientA.lastOf("prompt_accepted")?.data.id).toBe("test-id");
  });
});

describe("BroadcastManager extension UI and working state", () => {
  it("broadcasts a select dialog and forwards the first client response to Pi", async () => {
    const { manager, pi, clientA, clientB } = setup();
    await manager.sendPrompt("ask me", "client-a");
    pi.promptSource = "user";
    pi.emitPiEvent({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "Which one?",
      options: ["A", "B"],
    });
    await flushEvents();

    expect(clientA.lastOf("extension_ui_request")?.data).toMatchObject({
      id: "ui-1",
      method: "select",
      title: "Which one?",
      options: ["A", "B"],
    });
    expect(clientB.lastOf("extension_ui_request")?.data.id).toBe("ui-1");
    expect(clientA.lastOf("state")?.data.working).toMatchObject({
      kind: "extension_ui",
      message: "Which one?",
    });

    await manager.submitExtensionUiResponse(
      { type: "extension_ui_response", id: "ui-1", value: "B" },
      "client-a"
    );
    await manager.submitExtensionUiResponse(
      { type: "extension_ui_response", id: "ui-1", value: "A" },
      "client-b"
    );

    expect(pi.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "ui-1", value: "B" },
    ]);
    expect(clientB.lastOf("extension_ui_resolved")?.data).toEqual({
      id: "ui-1",
      cancelled: false,
    });
  });

  it("cancels a pending dialog on abort", async () => {
    const { manager, pi, clientA } = setup();
    await manager.sendPrompt("dangerous", "client-a");
    pi.promptSource = "user";
    pi.isPromptActive = true;
    pi.emitPiEvent({
      type: "extension_ui_request",
      id: "ui-2",
      method: "select",
      title: "Allow rm -rf?",
      options: ["Yes", "No"],
    });
    await flushEvents();

    const abortPromise = manager.abort();
    pi.settleRun("");
    await abortPromise;

    expect(pi.extensionUiResponses).toEqual([
      { type: "extension_ui_response", id: "ui-2", cancelled: true },
    ]);
    expect(clientA.lastOf("extension_ui_resolved")?.data.cancelled).toBe(true);
  });

  it("broadcasts compaction as working state", async () => {
    const { manager, pi, clientA } = setup();
    await manager.sendPrompt("long chat", "client-a");
    pi.promptSource = "user";
    pi.emitPiEvent({ type: "compaction_start", reason: "threshold" });
    await flushEvents();

    expect(clientA.lastOf("state")?.data.working).toMatchObject({
      kind: "compaction",
      message: "Compacting context…",
    });
    expect(clientA.lastOf("state")?.data.isCompacting).toBe(true);

    pi.emitPiEvent({
      type: "compaction_end",
      result: null,
      aborted: false,
    });
    await flushEvents();

    expect(clientA.lastOf("state")?.data.isCompacting).toBe(false);
  });

  it("broadcasts idle Pi errors to clients", async () => {
    const { pi, clientA } = setup();
    pi.emit("error", new Error("Pi error: quota exceeded"));
    await flushEvents();

    expect(clientA.lastOf("error")?.data.message).toBe("Pi error: quota exceeded");
  });
});
