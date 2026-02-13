import type { PiRpcClient } from "./pi-rpc.js";
import type { SessionManager } from "./session-manager.js";
import type { SessionWatcher } from "./session-watcher.js";
import type { MemoryWatcher } from "./memory-watcher.js";
import type { PiState } from "./types.js";

// Handle /status command - show current Pi state
export async function handleStatus(pi: PiRpcClient, sessionPath: string): Promise<string> {
  const state = await pi.getState();
  const stateData = state.data as PiState;
  const activeModel = stateData?.model;

  const lines = [
    `Current model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(unknown)"}`,
    `Session: ${sessionPath}`,
    `Running: ${pi.isRunning ? "yes" : "no"}`,
  ];

  return lines.join("\n");
}

// Handle /model command - view or change model
export async function handleModel(pi: PiRpcClient, args: string): Promise<string> {
  const arg = args.trim();

  // No args - show current model and usage
  if (!arg || arg === "") {
    const state = await pi.getState();
    const stateData = state.data as PiState;
    const activeModel = stateData?.model;

    return [
      `Current model: ${activeModel ? `${activeModel.provider}/${activeModel.id}` : "(unknown)"}`,
      "",
      "Usage:",
      "/model                    Show current model",
      "/model list               List available models",
      "/model <number>           Switch to model",
    ].join("\n");
  }

  // List available models
  if (arg === "list") {
    const response = await pi.getAvailableModels();
    if (!response.success || !response.data) {
      return "Failed to get available models.";
    }

    const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
    const models = data.models ?? [];

    const state = await pi.getState();
    const stateData = state.data as PiState;
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

  const response = await pi.getAvailableModels();
  if (!response.success || !response.data) {
    return "Failed to get available models.";
  }

  const data = response.data as { models: Array<{ provider: string; id: string; name: string }> };
  const models = data.models ?? [];

  if (index > models.length) {
    return `Model ${index} not found. Use /model list to see available models (1-${models.length}).`;
  }

  const selected = models[index - 1];

  try {
    await pi.setModelViaRpc(selected.provider, selected.id);
    return `Model changed to ${selected.provider}/${selected.id} (${selected.name})`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error("[Gateway] Failed to set model:", err);
    return `Failed to set model: ${errorMsg}`;
  }
}

// Handle /session command - show session info and stats
export async function handleSession(sessionManager: SessionManager): Promise<string> {
  const info = await sessionManager.getSessionInfo();
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  
  const lines = [
    `📁 Session: ${info.sessionPath}`,
    `📦 Archive: ${info.archiveDir}`,
    `🔄 Compactions: ${info.compactionCount}`,
  ];

  if (info.context) {
    const ctxLines = [
      ``,
      `🧠 Context:`,
      `   Model: ${info.context.model}`,
      `   Window: ${fmt(info.context.contextWindow)} tokens`,
      `   Compacts at: ${fmt(info.context.compactThreshold)} tokens`,
    ];
    if (info.currentContextTokens != null) {
      const pct = ((info.currentContextTokens / info.context.compactThreshold) * 100).toFixed(0);
      ctxLines.push(`   Current: ~${fmt(info.currentContextTokens)} tokens (${pct}% of compaction threshold)`);
    }
    lines.push(...ctxLines);
  }

  if (info.stats) {
    lines.push(
      ``,
      `📊 Cumulative stats:`,
      `   Messages: ${info.stats.messageCount}`,
      `   Tokens: ↑${fmt(info.stats.tokens.input)} ↓${fmt(info.stats.tokens.output)} (${fmt(info.stats.tokens.total)} total)`,
      `   Cost: $${info.stats.cost.toFixed(3)}`
    );
  }

  lines.push(
    ``,
    `Use /new to archive and start fresh session`
  );

  return lines.join("\n");
}

// Handle /new command - archive current session and start fresh
export async function handleNew(sessionManager: SessionManager, sessionPath: string, memoryWatcher?: MemoryWatcher): Promise<string> {
  const result = await sessionManager.archiveAndStartNew();

  if (result.error) {
    return `❌ Failed to start new session: ${result.error}`;
  }

  // Reset memory watcher offset so it re-reads the truncated file
  if (memoryWatcher) {
    await memoryWatcher.resetFileOffset(sessionPath);
  }

  const lines = [
    `✅ New session started`,
    ``,
    `Archived: ${result.archived}`,
  ];

  return lines.join("\n");
}

// Handle /takeover command - force reclaim session from TUI
export async function handleTakeover(
  pi: PiRpcClient,
  sessionWatcher: SessionWatcher,
): Promise<string> {
  try {
    console.log("[Gateway] /takeover: Checking for active TUI...");
    const result = await sessionWatcher.killTui();

    if (result.killed) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await pi.reload();

    return [
      `✅ Session reclaimed`,
      ``,
      result.killed ? `Killed TUI (PID ${result.pid})` : "No active TUI found",
      `Pi RPC reloaded`,
      ``,
      `Send your message now.`,
    ].join("\n");
  } catch (err) {
    console.error("[Gateway] /takeover failed:", err);
    return `❌ Failed to reclaim session: ${err instanceof Error ? err.message : String(err)}`;
  }
}
