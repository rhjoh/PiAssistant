import { copyFile, mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { PiRpcClient } from "./pi-rpc.js";

export interface SessionManagerOptions {
  sessionPath: string;
  archiveDir?: string;
  onArchive?: (archivePath: string, reason: "manual" | "compaction") => void;
}

export class SessionManager {
  private sessionPath: string;
  private archiveDir: string;
  private compactionCount = 0;
  private onArchive?: (archivePath: string, reason: "manual" | "compaction") => void;

  constructor(private pi: PiRpcClient, options: SessionManagerOptions) {
    this.sessionPath = options.sessionPath;
    this.archiveDir = options.archiveDir ?? join(dirname(options.sessionPath), "archived");
    this.onArchive = options.onArchive;
  }

  /**
   * Wire up Pi RPC events for session management
   */
  setupEventHandlers(): void {
    this.pi.on("event", async (event) => {
      if (event.type === "auto_compaction_start") {
        console.log(`[SessionManager] Compaction starting (reason: ${event.reason})`);
        await this.archiveBeforeCompaction();
      }

      if (event.type === "auto_compaction_end") {
        this.compactionCount++;
        const result = event.result;
        if (result) {
          console.log(
            `[SessionManager] Compaction #${this.compactionCount} complete. ` +
              `Tokens before: ${result.tokensBefore}`
          );
        } else if (event.aborted) {
          console.log(`[SessionManager] Compaction aborted`);
        }
      }
    });
  }

  /**
   * Archive the current session before compaction
   */
  async archiveBeforeCompaction(): Promise<string | null> {
    try {
      // Ensure archive directory exists
      if (!existsSync(this.archiveDir)) {
        await mkdir(this.archiveDir, { recursive: true });
        console.log(`[SessionManager] Created archive directory: ${this.archiveDir}`);
      }

      // Generate timestamped filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const originalName = basename(this.sessionPath, ".jsonl");
      const archiveName = `${originalName}_pre-compact_${timestamp}.jsonl`;
      const archivePath = join(this.archiveDir, archiveName);

      // Copy session file
      await copyFile(this.sessionPath, archivePath);
      console.log(`[SessionManager] Archived session to: ${archivePath}`);

      // Notify if callback configured
      this.onArchive?.(archivePath, "compaction");

      return archivePath;
    } catch (err) {
      console.error(`[SessionManager] Failed to archive session:`, err);
      return null;
    }
  }

  /**
   * Get the current compaction count for this session
   */
  getCompactionCount(): number {
    return this.compactionCount;
  }

  /**
   * Reset compaction count (e.g., after starting new session)
   */
  resetCompactionCount(): void {
    this.compactionCount = 0;
  }

  /**
   * Archive current session and start a new one
   * Returns the path to the archived session, or null if archival failed
   */
  async archiveAndStartNew(): Promise<{ archived: string | null; error?: string }> {
    try {
      // Ensure archive directory exists
      if (!existsSync(this.archiveDir)) {
        await mkdir(this.archiveDir, { recursive: true });
      }

      // Generate timestamped filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const originalName = basename(this.sessionPath, ".jsonl");
      const archiveName = `${originalName}_${timestamp}.jsonl`;
      const archivePath = join(this.archiveDir, archiveName);

      // Copy session file before starting new session
      await copyFile(this.sessionPath, archivePath);
      console.log(`[SessionManager] Archived session to: ${archivePath}`);

      // Notify if callback configured
      this.onArchive?.(archivePath, "manual");

      // Tell Pi to start a new session
      const response = await this.pi.newSession(archivePath);
      
      if (!response.success) {
        return { archived: archivePath, error: response.error ?? "Failed to start new session" };
      }

      // Reset compaction count for new session
      this.resetCompactionCount();

      return { archived: archivePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SessionManager] Failed to archive and start new session:`, err);
      return { archived: null, error: message };
    }
  }

  /**
   * Get session info for /session command
   */
  async getSessionInfo(): Promise<{
    sessionPath: string;
    archiveDir: string;
    compactionCount: number;
    stats: {
      tokens: { input: number; output: number; total: number };
      cost: number;
      messageCount: number;
    } | null;
    context: {
      contextWindow: number;
      compactThreshold: number;
      model: string;
    } | null;
  }> {
    let stats = null;
    let context = null;
    
    try {
      const response = await this.pi.getSessionStats();
      if (response.success && response.data) {
        const data = response.data as {
          tokens: { input: number; output: number; total: number };
          cost: number;
          totalMessages: number;
        };
        stats = {
          tokens: data.tokens,
          cost: data.cost,
          messageCount: data.totalMessages,
        };
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to get session stats:`, err);
    }

    try {
      const stateResponse = await this.pi.getState();
      if (stateResponse.success && stateResponse.data) {
        const state = stateResponse.data as {
          model: { id: string; contextWindow: number } | null;
        };
        if (state.model) {
          const reserveTokens = 16384; // Default from Pi settings
          context = {
            contextWindow: state.model.contextWindow,
            compactThreshold: state.model.contextWindow - reserveTokens,
            model: state.model.id,
          };
        }
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to get state:`, err);
    }

    return {
      sessionPath: this.sessionPath,
      archiveDir: this.archiveDir,
      compactionCount: this.compactionCount,
      stats,
      context,
    };
  }
}
