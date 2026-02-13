import { createReadStream, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

type MemoryWatcherState = Record<
  string,
  {
    offset: number;
    mtimeMs: number;
  }
>;

type MemoryEntry = {
  timestamp: number;
  role: string;
  text: string;
  sessionPath: string;
};

type MemoryWatcherOptions = {
  sessionDir: string;
  outputDir: string;
  statePath: string;
  model: string;
  provider: string;
  intervalMs: number;
  activeWindowMs: number;
  memoryPromptPath: string;
};

export class MemoryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private state: MemoryWatcherState = {};
  private running = false;

  constructor(private options: MemoryWatcherOptions) {}

  async start(): Promise<void> {
    await this.loadState();
    // Don't await first tick - let it run in background so we don't block startup
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(`[MemoryWatcher] Tick started`);
    try {
      const entries = await this.collectNewEntries();
      if (entries.length === 0) {
        console.log(`[MemoryWatcher] No new entries found`);
        return;
      }
      console.log(`[MemoryWatcher] Processing ${entries.length} new entries`);

      const context = this.formatContext(entries);
      const roles = entries.reduce((acc, e) => {
        acc[e.role] = (acc[e.role] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      const rolesSummary = Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(" ");
      console.log(`[MemoryWatcher] Input: ${entries.length} entries (${rolesSummary}), ${context.length} chars`);
      await this.ensureMemoryFiles();

      await this.extractAndAppend({
        target: "memory",
        prompt: await this.buildMemoryPrompt(context),
        filePath: join(this.options.outputDir, "memory.md"),
      });

      await this.saveState();
    } catch (error) {
      console.error("[MemoryWatcher] Error:", error);
    } finally {
      this.running = false;
    }
  }

  private async collectNewEntries(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const now = Date.now();
    const sessionFiles = await this.listSessionFiles();

    for (const sessionPath of sessionFiles) {
      const stat = await fs.stat(sessionPath);
      const existing = this.state[sessionPath];

      if (!existing) {
        const isActive = now - stat.mtimeMs <= this.options.activeWindowMs;
        this.state[sessionPath] = {
          offset: isActive ? 0 : stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }

      const state = this.state[sessionPath];
      if (stat.size <= state.offset) {
        state.mtimeMs = stat.mtimeMs;
        continue;
      }

      const bytesToRead = stat.size - state.offset;
      const newLines = await this.readNewLines(sessionPath, state.offset);
      console.log(`[MemoryWatcher] ${sessionPath}: read ${newLines.length} lines (${bytesToRead} bytes)`);
      state.offset = stat.size;
      state.mtimeMs = stat.mtimeMs;

      for (const line of newLines) {
        const entry = this.parseMemoryEntry(line, sessionPath);
        if (entry) entries.push(entry);
      }
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  }

  private async listSessionFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.options.sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(this.options.sessionDir, entry.name));
  }

  private async readNewLines(filePath: string, offset: number): Promise<string[]> {
    const stream = createReadStream(filePath, { start: offset, encoding: "utf8" });
    const lines: string[] = [];
    let buffer = "";

    for await (const chunk of stream) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        if (line) lines.push(line);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing) lines.push(trailing);
    return lines;
  }

  private parseMemoryEntry(line: string, sessionPath: string): MemoryEntry | null {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "message" || !parsed.message) return null;

      const role = parsed.message.role;
      if (!role || !["user", "assistant"].includes(role)) {
        return null;
      }

      const text = this.extractText(parsed.message.content);
      if (!text) return null;

      // Skip system messages that shouldn't be extracted (e.g., heartbeats)
      const trimmed = text.trim();
      if (trimmed.includes("<!-- MEMORY-WATCHER-SKIP -->")) {
        return null;
      }

      // Skip heartbeat no-action markers (exact match or contained)
      if (trimmed === "[[NO_ACTION]]" || trimmed === "[[NO-ACTION]]" ||
          trimmed.includes("[[NO_ACTION]]") || trimmed.includes("[[NO-ACTION]]")) {
        return null;
      }

      const timestamp = parsed.message.timestamp ?? parsed.timestamp ?? Date.now();
      return { timestamp, role, text, sessionPath };
    } catch {
      return null;
    }
  }

  private extractText(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part?.type === "text" && typeof part.text === "string") return part.text;
          if (part?.type === "thinking") return "";
          return "";
        })
        .join("\n")
        .trim();
    }
    return "";
  }

  private formatContext(entries: MemoryEntry[]): string {
    return entries
      .map((entry) => {
        const iso = new Date(entry.timestamp).toISOString();
        return `- (${entry.role}, ${iso}) ${entry.text}`;
      })
      .join("\n");
  }

  private async buildMemoryPrompt(context: string): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const template = await fs.readFile(this.options.memoryPromptPath, "utf8");
    let existingMemories = "";
    try {
      existingMemories = await fs.readFile(join(this.options.outputDir, "memory.md"), "utf8");
    } catch { /* file may not exist */ }
    return template
      .replace("{{TODAY}}", today)
      .replace("{{EXISTING_MEMORIES}}", existingMemories)
      .replace("{{CONTEXT}}", context);
  }

  private async extractAndAppend(params: {
    target: "memory";
    prompt: string;
    filePath: string;
  }): Promise<void> {
    console.log(`[MemoryWatcher] Extracting ${params.target} (provider/model: ${this.options.provider}/${this.options.model})...`);
    console.log(`[MemoryWatcher:${params.target}] Prompt (${params.prompt.length} chars):`);
    console.log(`--- START PROMPT ---`);
    console.log(params.prompt);
    console.log(`--- END PROMPT ---`);
    
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        const timeoutMs = 60000; // 1 minute timeout
        const timeoutId = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`Pi extraction timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        
        const startTime = Date.now();
        const progressInterval = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`[MemoryWatcher:${params.target}] Still extracting... (${elapsed}s)`);
        }, 10000); // Every 10 seconds
        
        const proc = spawn("pi", [
          "--print",
          "--no-session",
          "--no-tools",
          "--provider",
          this.options.provider,
          "--model",
          this.options.model,
          params.prompt,
        ]);
        
        proc.stdin.end(); // Close stdin so Pi doesn't wait
        
        let out = "";
        let err = "";
        
        proc.stdout.on("data", (chunk) => {
          out += chunk.toString();
        });
        
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          err += text;
          console.log(`[MemoryWatcher:${params.target}:stderr] ${text.trim()}`);
        });
        
        proc.on("close", (code) => {
          clearTimeout(timeoutId);
          clearInterval(progressInterval);
          if (code === 0) {
            resolve(out);
          } else {
            console.error(`[MemoryWatcher] Pi stderr: ${err}`);
            reject(new Error(`pi exited with code ${code}`));
          }
        });
        
        proc.on("error", (err) => {
          clearTimeout(timeoutId);
          clearInterval(progressInterval);
          reject(err);
        });
      });
    } catch (err) {
      console.error(`[MemoryWatcher] Extraction failed for ${params.target}:`, err);
      return;
    }

    const output = stdout.trim();

    if (!output) {
      console.log(`[MemoryWatcher] ${params.target}: empty response, skipping`);
      return;
    }
    
    if (output === "NOOP") {
      console.log(`[MemoryWatcher] ${params.target}: NOOP — nothing to extract`);
      return;
    }

    // Log the actual artefacts being saved
    console.log(`[MemoryWatcher] ━━━ ${params.target.toUpperCase()} ARTEFACTS ━━━`);
    console.log(output);
    console.log(`[MemoryWatcher] ━━━ END ${params.target.toUpperCase()} ━━━`);

    await fs.appendFile(params.filePath, `${output}\n`);
    console.log(`[MemoryWatcher] Saved to ${params.filePath}`);
  }

  private async ensureMemoryFiles(): Promise<void> {
    await fs.mkdir(this.options.outputDir, { recursive: true });
    await this.ensureFile(join(this.options.outputDir, "memory.md"), "# Memory (long-term)\n\n");
  }

  private async ensureFile(path: string, header: string): Promise<void> {
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, header);
    }
  }

  async resetFileOffset(filePath: string): Promise<void> {
    if (this.state[filePath]) {
      this.state[filePath].offset = 0;
      await this.saveState();
      console.log(`[MemoryWatcher] Reset offset for ${filePath}`);
    }
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.options.statePath, "utf8");
      this.state = JSON.parse(raw) as MemoryWatcherState;
    } catch {
      this.state = {};
    }
  }

  private async saveState(): Promise<void> {
    await fs.mkdir(dirname(this.options.statePath), { recursive: true });
    await fs.writeFile(this.options.statePath, JSON.stringify(this.state, null, 2));
  }
}
