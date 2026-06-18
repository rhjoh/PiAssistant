import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryStore, WriteMemoryInput } from "./memory-store.js";

type SessionOffsetState = Record<
  string,
  {
    offset: number;
    mtimeMs: number;
  }
>;

type DailyContextState = {
  offsets: SessionOffsetState;
  todayDate?: string;
  lastDailyExtractionDate?: string;
};

type SessionEntry = {
  timestamp: number;
  role: "user" | "assistant";
  text: string;
  sessionPath: string;
};

type ExtractedMemoryCandidate = WriteMemoryInput & {
  confidence?: number;
  archivePatterns?: string[];
};

type DailyExtractionOutput = {
  memories?: ExtractedMemoryCandidate[];
};

export type DailyContextTriggerResult = {
  updatedToday: boolean;
  entriesProcessed: number;
  extractionRan: boolean;
  memoriesSaved: number;
  skippedReason?: "already_running" | "main_session_busy" | "already_extracted_today" | "before_extraction_hour" | "no_entries";
  date: string;
};

export type DailyContextOptions = {
  sessionDir: string;
  statePath: string;
  todayPath: string;
  dailyDir: string;
  intervalMs: number;
  dailyExtractionHour: number;
  provider: string;
  model: string;
  cwd: string;
  memoryStore: MemoryStore;
  briefingPath: string;
  maxTranscriptChars: number;
  onTick?: () => void;
  isBusy?: () => boolean;
};

export class DailyContextManager {
  private timer: NodeJS.Timeout | null = null;
  private state: DailyContextState = { offsets: {} };
  private running = false;
  private initialized = false;

  constructor(private options: DailyContextOptions) {}

  async start(): Promise<void> {
    await this.initialize();
    void this.tick("startup", false);
    this.timer = setInterval(() => {
      void this.tick("interval", false);
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Manually trigger a daily context tick (today.md refresh and optional extraction).
   * Returns a summary of what happened.
   */
  async triggerNow(forceExtraction = false): Promise<DailyContextTriggerResult> {
    await this.initialize();
    return this.tick("interval", forceExtraction, true);
  }

  private async tick(reason: "startup" | "interval", forceExtraction = false, throwOnError = false): Promise<DailyContextTriggerResult> {
    const date = formatDateKey(new Date());
    if (this.running) {
      console.log("[DailyContext] Tick skipped — previous tick still running");
      return {
        updatedToday: false,
        entriesProcessed: 0,
        extractionRan: false,
        memoriesSaved: 0,
        skippedReason: "already_running",
        date,
      };
    }

    if (this.options.isBusy?.()) {
      console.log("[DailyContext] Tick skipped — main session is busy");
      return {
        updatedToday: false,
        entriesProcessed: 0,
        extractionRan: false,
        memoriesSaved: 0,
        skippedReason: "main_session_busy",
        date,
      };
    }

    this.running = true;
    this.options.onTick?.();
    const started = Date.now();
    console.log(`[DailyContext] Tick started (${reason})`);
    let result: DailyContextTriggerResult = {
      updatedToday: false,
      entriesProcessed: 0,
      extractionRan: false,
      memoriesSaved: 0,
      date,
    };

    try {
      await this.rollTodayIfNeeded();
      const entries = await this.collectNewEntries();
      if (entries.length > 0) {
        await this.updateToday(entries);
        result.updatedToday = true;
        result.entriesProcessed = entries.length;
      } else {
        console.log("[DailyContext] No new entries for today.md");
      }

      const extraction = await this.maybeRunDailyExtraction(forceExtraction);
      result = {
        ...result,
        extractionRan: extraction.ran,
        memoriesSaved: extraction.memoriesSaved,
        skippedReason: extraction.skippedReason,
      };
      await this.saveState();
    } catch (error) {
      console.error("[DailyContext] Error:", error);
      if (throwOnError) throw error;
    } finally {
      this.running = false;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[DailyContext] Tick finished — ${elapsed}s`);
    }

    return result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadState();
    await this.ensureFiles();
    this.initialized = true;
  }

  private async ensureFiles(): Promise<void> {
    await mkdir(dirname(this.options.todayPath), { recursive: true });
    await mkdir(this.options.dailyDir, { recursive: true });
    if (!existsSync(this.options.todayPath)) {
      await writeFile(this.options.todayPath, emptyTodayFile(), "utf8");
    }
    this.state.todayDate ??= formatDateKey(new Date());
  }

  private async rollTodayIfNeeded(): Promise<void> {
    const dateKey = formatDateKey(new Date());
    if (!this.state.todayDate) {
      this.state.todayDate = dateKey;
      return;
    }
    if (this.state.todayDate === dateKey) return;

    await this.archiveToday(this.state.todayDate);
    await writeFile(this.options.todayPath, emptyTodayFile(), "utf8");
    console.log(`[DailyContext] Rolled today.md from ${this.state.todayDate} to ${dateKey}`);
    this.state.todayDate = dateKey;
  }

  private async collectNewEntries(): Promise<SessionEntry[]> {
    const entries: SessionEntry[] = [];
    const sessionFiles = await this.listSessionFiles();

    for (const sessionPath of sessionFiles) {
      const fileStat = await stat(sessionPath);
      const existing = this.state.offsets[sessionPath];
      if (!existing) {
        const offset = formatDateKey(new Date(fileStat.mtimeMs)) === formatDateKey(new Date())
          ? 0
          : fileStat.size;
        this.state.offsets[sessionPath] = { offset, mtimeMs: fileStat.mtimeMs };
      }

      const state = this.state.offsets[sessionPath];
      if (fileStat.size < state.offset) {
        console.log(`[DailyContext] ${sessionPath}: file shrank, resetting offset`);
        state.offset = 0;
      }

      if (fileStat.size === state.offset) {
        state.mtimeMs = fileStat.mtimeMs;
        continue;
      }

      const lines = await readNewLines(sessionPath, state.offset);
      // Update offset AFTER parsing to avoid data loss on crash
      for (const line of lines) {
        const entry = parseSessionEntry(line, sessionPath);
        if (entry) entries.push(entry);
      }
      state.offset = fileStat.size;
      state.mtimeMs = fileStat.mtimeMs;
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  }

  private async listSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await this.addJsonlFiles(files, this.options.sessionDir);
    await this.addJsonlFiles(files, join(this.options.sessionDir, "archived"));
    return files;
  }

  private async addJsonlFiles(files: string[], dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(join(dir, entry.name));
        }
      }
    } catch {
      // Directory may not exist yet.
    }
  }

  private async updateToday(entries: SessionEntry[]): Promise<void> {
    const existing = await readFileIfExists(this.options.todayPath);
    const transcript = formatTranscript(entries, this.options.maxTranscriptChars);
    const now = new Date();
    const prompt = [
      "You update a rolling working context file for a personal assistant.",
      "",
      "Return ONLY markdown for the full updated today.md file. Do not wrap in code fences.",
      "",
      "Purpose:",
      "- Capture what the user and assistant are working on today.",
      "- Preserve practical context across context resets.",
      "- Keep it concise, factual, and temporary.",
      "",
      "Include these sections:",
      "# Today",
      "Generated: <current local timestamp>",
      "## Active Work",
      "## Decisions",
      "## Open Questions",
      "## Recent Implementation Context",
      "## Things To Carry Forward",
      "",
      "Rules:",
      "- Do not include secrets, API keys, passwords, cookie values, or raw tokens.",
      "- Do not preserve assistant reasoning.",
      "- Prefer rewriting/condensing over appending forever.",
      "- Keep durable long-term memories out unless they are needed to understand today's work.",
      "- If little happened, keep the previous useful context and update Generated.",
      "",
      `Current local timestamp: ${formatLocalTimestamp(now)}`,
      "",
      "Existing today.md:",
      "```md",
      existing.trim() || emptyTodayFile().trim(),
      "```",
      "",
      "New transcript since last update:",
      "```text",
      transcript,
      "```",
    ].join("\n");

    const updated = await this.runPiPrompt(prompt, "today");
    await writeFile(this.options.todayPath, ensureMarkdownToday(updated), "utf8");
    console.log(`[DailyContext] Updated ${this.options.todayPath} from ${entries.length} entries`);
  }

  private async maybeRunDailyExtraction(force = false): Promise<{ ran: boolean; memoriesSaved: number; skippedReason?: DailyContextTriggerResult["skippedReason"] }> {
    const now = new Date();
    const dateKey = formatDateKey(now);
    if (!force && this.state.lastDailyExtractionDate === dateKey) {
      return { ran: false, memoriesSaved: 0, skippedReason: "already_extracted_today" };
    }
    if (!force && now.getHours() < this.options.dailyExtractionHour) {
      return { ran: false, memoriesSaved: 0, skippedReason: "before_extraction_hour" };
    }

    const entries = await this.collectEntriesForDate(dateKey);
    if (entries.length === 0) {
      this.state.lastDailyExtractionDate = dateKey;
      return { ran: false, memoriesSaved: 0, skippedReason: "no_entries" };
    }

    const today = await readFileIfExists(this.options.todayPath);
    const briefing = await readFileIfExists(this.options.briefingPath);
    const transcript = formatTranscript(entries, this.options.maxTranscriptChars);

    const prompt = [
      "You extract durable memories from one day of an assistant session.",
      "",
      "Return ONLY valid JSON. Do not wrap in code fences.",
      "",
      "Schema:",
      '{ "memories": [ { "content": string, "kind": string, "scope": "user" | "project" | "daily" | "session", "importance": number, "project"?: string, "archivePatterns"?: string[] } ] }',
      "",
      "The `archivePatterns` field is optional. Use it to list substrings or patterns",
      "that identify existing memories which this new memory supersedes or contradicts.",
      "For example, if a new memory says 'The user now prefers Neovim'",
      "and the existing briefing says 'The user prefers VS Code', include 'prefers VS Code'",
      "in archivePatterns. The system will archive matching memories automatically.",
      "",
      "What to save:",
      "- Stable user preferences, facts, goals, constraints.",
      "- Important project decisions and architecture context.",
      "- Important recent events that should be available tomorrow.",
      "",
      "What not to save:",
      "- Secrets, API keys, passwords, cookie values, tokens, credentials.",
      "- Routine chatter, temporary debugging noise, raw tool output.",
      "- Assistant reasoning or internal thoughts.",
      "- Duplicates of the existing briefing.",
      "",
      "When a new fact contradicts or supersedes an existing one, DO include the new",
      "fact AND set archivePatterns to identify the old fact. For example:",
      '- New: "The deployment target is now production"',
      '- archivePatterns: ["deployment target is staging"]',
      "",
      "Importance:",
      "- 5: must appear in startup context.",
      "- 4: highly useful future context.",
      "- 3: useful, but not startup-critical.",
      "- 1-2: minor recent context.",
      "",
      `Date being extracted: ${dateKey}`,
      "",
      "Existing briefing:",
      "```md",
      truncateMiddle(briefing, 12000),
      "```",
      "",
      "today.md:",
      "```md",
      truncateMiddle(today, 12000),
      "```",
      "",
      "Session transcript for the day:",
      "```text",
      transcript,
      "```",
    ].join("\n");

    const raw = await this.runPiPrompt(prompt, "daily-extract");
    const parsed = parseDailyExtraction(raw);
    let saved = 0;
    for (const memory of parsed.memories ?? []) {
      if (!isGoodMemoryCandidate(memory)) continue;
      await this.options.memoryStore.writeMemory({
        content: memory.content,
        kind: memory.kind,
        scope: memory.scope,
        importance: memory.importance,
        project: memory.project,
        source: "daily-context",
        sourceId: dateKey,
      });
      saved++;

      // Archive memories that this new one supersedes
      if (memory.archivePatterns && memory.archivePatterns.length > 0) {
        await this.archiveSupersededMemories(memory.archivePatterns);
      }
    }

    await this.options.memoryStore.writeBriefingFile();
    await this.archiveToday(dateKey);
    this.state.lastDailyExtractionDate = dateKey;
    console.log(`[DailyContext] Daily extraction complete for ${dateKey}: saved ${saved} memories`);
    return { ran: true, memoriesSaved: saved };
  }

  private async archiveSupersededMemories(patterns: string[]): Promise<void> {
    if (!patterns.length) return;
    for (const pattern of patterns) {
      const results = await this.options.memoryStore.searchMemory({
        query: pattern,
        limit: 5,
        scope: "user",
      });
      for (const result of results) {
        // Check if the pattern is a meaningful substring of the memory content
        // to avoid false positives from vague patterns
        if (result.content.toLowerCase().includes(pattern.toLowerCase())) {
          this.options.memoryStore.archiveMemory(result.id);
          console.log(`[DailyContext] Archived superseded memory ${result.id}: "${result.content.slice(0, 80)}..." (matched pattern: "${pattern}")`);
        }
      }
    }
  }

  private async collectEntriesForDate(dateKey: string): Promise<SessionEntry[]> {
    const entries: SessionEntry[] = [];
    const files = await this.listSessionFiles();
    for (const file of files) {
      const lines = await readAllLines(file);
      for (const line of lines) {
        const entry = parseSessionEntry(line, file);
        if (!entry) continue;
        if (formatDateKey(new Date(entry.timestamp)) === dateKey) entries.push(entry);
      }
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries;
  }

  private async archiveToday(dateKey: string): Promise<void> {
    const today = await readFileIfExists(this.options.todayPath);
    if (!today.trim()) return;
    const archivePath = join(this.options.dailyDir, `${dateKey}.md`);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, today, "utf8");
  }

  private async runPiPrompt(prompt: string, purpose: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "assistant-daily-context-"));
    const promptPath = join(tempDir, `${purpose}.md`);
    await writeFile(promptPath, prompt, "utf8");

    const args = [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-context-files",
      "--provider",
      this.options.provider,
      "--model",
      this.options.model,
      `@${promptPath}`,
    ];

    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn("pi", args, {
          cwd: this.options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            reject(new Error(`pi ${purpose} exited ${code}: ${stderr.trim() || stdout.trim()}`));
          }
        });
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async loadState(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.options.statePath, "utf8")) as DailyContextState;
      this.state.offsets ??= {};
    } catch {
      this.state = { offsets: {} };
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true });
    await writeFile(this.options.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

async function readNewLines(filePath: string, offset: number): Promise<string[]> {
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

async function readAllLines(filePath: string): Promise<string[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function parseSessionEntry(line: string, sessionPath: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      timestamp?: string | number;
      message?: { role?: string; content?: unknown; timestamp?: string | number };
    };
    if (parsed.type !== "message" || !parsed.message) return null;
    const role = parsed.message.role;
    if (role !== "user" && role !== "assistant") return null;
    const text = extractText(parsed.message.content);
    if (!text) return null;
    if (shouldSkipText(text)) return null;
    return {
      role,
      text,
      timestamp: normalizeTimestamp(parsed.message.timestamp ?? parsed.timestamp),
      sessionPath,
    };
  } catch {
    return null;
  }
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shouldSkipText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.includes("<!-- MEMORY-WATCHER-SKIP -->") ||
    trimmed === "[[NO_ACTION]]" ||
    trimmed === "[[NO-ACTION]]" ||
    trimmed.includes("[[NO_ACTION]]") ||
    trimmed.includes("[[NO-ACTION]]")
  );
}

function normalizeTimestamp(value: string | number | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function formatTranscript(entries: SessionEntry[], maxChars: number): string {
  const lines = entries.map((entry) => {
    const iso = new Date(entry.timestamp).toISOString();
    const session = basename(entry.sessionPath);
    return `- (${entry.role}, ${iso}, ${session}) ${sanitizeTranscriptText(entry.text)}`;
  });
  return truncateMiddle(lines.join("\n"), maxChars);
}

function sanitizeTranscriptText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/xai-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/AQED[A-Za-z0-9_-]{20,}/g, "[REDACTED_COOKIE]")
    .trim();
}

function parseDailyExtraction(raw: string): DailyExtractionOutput {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as DailyExtractionOutput;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function isGoodMemoryCandidate(candidate: ExtractedMemoryCandidate): candidate is Required<Pick<WriteMemoryInput, "content">> & ExtractedMemoryCandidate {
  if (!candidate || typeof candidate !== "object") return false;
  if (typeof candidate.content !== "string" || candidate.content.trim().length < 12) return false;
  if (containsSecret(candidate.content)) return false;
  if (candidate.importance !== undefined && !Number.isFinite(candidate.importance)) return false;
  return true;
}

function containsSecret(text: string): boolean {
  return (
    /sk-[A-Za-z0-9_-]{20,}/.test(text) ||
    /xai-[A-Za-z0-9_-]{20,}/.test(text) ||
    /password\s*(is|:)/i.test(text) ||
    /cookie/i.test(text) && /value|token|li_at|auth/i.test(text)
  );
}

function ensureMarkdownToday(text: string): string {
  const cleaned = text
    .trim()
    .replace(/^```md\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  if (cleaned.startsWith("# Today")) return `${cleaned}\n`;
  return `# Today\n\n${cleaned}\n`;
}

function emptyTodayFile(): string {
  return [
    "# Today",
    "",
    `Generated: ${formatLocalTimestamp(new Date())}`,
    "",
    "## Active Work",
    "- No active work captured yet.",
    "",
    "## Decisions",
    "- None captured yet.",
    "",
    "## Open Questions",
    "- None captured yet.",
    "",
    "## Recent Implementation Context",
    "- None captured yet.",
    "",
    "## Things To Carry Forward",
    "- None captured yet.",
    "",
  ].join("\n");
}

async function readFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTimestamp(date: Date): string {
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  return `${text.slice(0, half)}\n\n[... truncated ${text.length - maxChars} chars ...]\n\n${text.slice(-half)}`;
}
