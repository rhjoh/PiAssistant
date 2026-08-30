import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { lookup } from "mime-types";
import type { StatusProvider } from "./status-types.js";
import type { MemoryScope, MemoryStore, SearchMemoryInput, WriteMemoryInput } from "./memory-store.js";
import type { SessionManager } from "./session-manager.js";
import type { DailyContextManager } from "./daily-context.js";
import type { CreateTaskInput, TaskStore, UpdateTaskInput } from "./task-store.js";
import type { TaskScheduler } from "./task-scheduler.js";

/**
 * HTTP API server for local Gateway APIs and file serving.
 */
export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null;
  private readonly allowedRoots: string[];
  private statusProvider: StatusProvider | null = null;
  private memoryStore: MemoryStore | null = null;
  private sessionManager: SessionManager | null = null;
  private taskStore: TaskStore | null = null;
  private taskScheduler: TaskScheduler | null = null;
  private dailyContext: DailyContextManager | null = null;

  constructor(
    private port: number = 3457,
    allowedRoots: string[] = [],
    private wsPort: number = 3456,
    private host: string = "127.0.0.1"
  ) {
    this.allowedRoots = allowedRoots.map((root) => resolve(this.expandHome(root)));
  }

  setStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  setMemoryStore(store: MemoryStore): void {
    this.memoryStore = store;
  }

  setSessionManager(sessionManager: SessionManager): void {
    this.sessionManager = sessionManager;
  }

  setTaskServices(taskStore: TaskStore, taskScheduler: TaskScheduler): void {
    this.taskStore = taskStore;
    this.taskScheduler = taskScheduler;
  }

  setDailyContext(dailyContext: DailyContextManager): void {
    this.dailyContext = dailyContext;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        console.error(`[ApiServer] Error:`, err);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[ApiServer] Serving API at http://${this.host}:${this.port}`);
        if (this.allowedRoots.length > 0) {
          console.log(`[ApiServer] File roots: ${this.allowedRoots.join(", ")}`);
        }
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    console.log("[ApiServer] Stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Local single-user server - allow cross-origin requests from web clients
    // (vite dev server and the static web UI server run on different origins).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const url = requestUrl.pathname;

    // Status endpoint
    if (url === "/status" && req.method === "GET") {
      await this.handleStatusRequest(res);
      return;
    }

    if (url.startsWith("/memory/")) {
      await this.handleMemoryRequest(req, res, url);
      return;
    }

    if (url.startsWith("/session")) {
      await this.handleSessionRequest(req, res, url);
      return;
    }

    if (url.startsWith("/api/tasks")) {
      await this.handleTaskRequest(req, res, url, requestUrl);
      return;
    }

    // Only serve /files/* paths
    if (!url.startsWith("/files/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Extract path and resolve safely
    const filePath = decodeURIComponent(requestUrl.pathname.slice("/files/".length));

    // Security: only allow absolute paths
    if (!filePath.startsWith("/") && !filePath.startsWith("~/")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: only absolute paths allowed");
      return;
    }

    // Expand ~ to home directory
    const resolvedPath = this.expandHome(filePath);

    // Security: prevent directory traversal (including through symlinks)
    const fullPath = resolve(resolvedPath);
    if (!this.isAllowedPath(fullPath)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: path outside allowed roots");
      return;
    }

    // Check file exists and is readable
    if (!existsSync(fullPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("File not found");
      return;
    }

    // Security: resolve symlinks and re-check that the real path is still allowed
    const realPath = realpathSync(fullPath);
    if (!this.isAllowedPath(realPath)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: symlink target outside allowed roots");
      return;
    }

    const stats = statSync(realPath);
    if (!stats.isFile()) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: not a file");
      return;
    }

    // Set content type based on extension
    const contentType = lookup(extname(realPath)) || "application/octet-stream";

    // Stream the file
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "public, max-age=3600",
    });

    const stream = createReadStream(realPath);
    stream.pipe(res);

    stream.on("error", (err) => {
      console.error(`[ApiServer] Error streaming ${fullPath}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    });
  }

  private async handleStatusRequest(res: ServerResponse): Promise<void> {
    if (!this.statusProvider) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Status not available" }));
      return;
    }

    const status = await this.statusProvider.getStatus();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(status, null, 2));
  }

  private async handleMemoryRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<void> {
    if (!this.memoryStore) {
      this.sendJson(res, 503, { error: "Memory store not available" });
      return;
    }

    try {
      if (path === "/memory/search" && req.method === "POST") {
        const body = await readJsonBody<SearchMemoryInput>(req);
        const results = await this.memoryStore.searchMemory(body);
        this.sendJson(res, 200, { results });
        return;
      }

      if (path === "/memory/write" && req.method === "POST") {
        const body = await readJsonBody<WriteMemoryInput>(req);
        const memory = await this.memoryStore.writeMemory(body);
        await this.memoryStore.writeBriefingFile();
        this.sendJson(res, 200, { memory });
        return;
      }

      if (path === "/memory/briefing" && req.method === "GET") {
        const briefing = this.memoryStore.buildBriefing();
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(briefing);
        return;
      }

      if (path === "/memory/briefing" && req.method === "POST") {
        const body = await readJsonBody<{ project?: string; maxItems?: number }>(req);
        const briefing = this.memoryStore.buildBriefing({
          project: body.project,
          maxItems: body.maxItems,
        });
        this.sendJson(res, 200, { briefing });
        return;
      }

      if (path === "/memory/update" && req.method === "POST") {
        const body = await readJsonBody<{ id: number; content?: string; kind?: string; scope?: string; importance?: number; project?: string | null }>(req);
        if (body.id === undefined || body.id === null) {
          this.sendJson(res, 400, { error: "id is required" });
          return;
        }
        const memory = this.memoryStore.updateMemory(body.id, {
          content: body.content,
          kind: body.kind,
          scope: body.scope as MemoryScope | undefined,
          importance: body.importance,
          project: body.project,
        });
        await this.memoryStore.writeBriefingFile();
        this.sendJson(res, 200, { memory });
        return;
      }

      if (path === "/memory/archive" && req.method === "POST") {
        const body = await readJsonBody<{ ids: number[] }>(req);
        if (!Array.isArray(body.ids) || body.ids.length === 0) {
          this.sendJson(res, 400, { error: "ids array is required" });
          return;
        }
        const archived = this.memoryStore.archiveMemories(body.ids);
        await this.memoryStore.writeBriefingFile();
        this.sendJson(res, 200, { archived });
        return;
      }

      if (path === "/memory/get" && req.method === "GET") {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const idParam = url.searchParams.get("id");
        if (!idParam) {
          this.sendJson(res, 400, { error: "id query parameter is required" });
          return;
        }
        const id = parseInt(idParam, 10);
        if (isNaN(id)) {
          this.sendJson(res, 400, { error: "id must be a number" });
          return;
        }
        const memory = this.memoryStore.getMemory(id);
        this.sendJson(res, 200, { memory });
        return;
      }

      if (path === "/memory/extract" && req.method === "POST") {
        if (!this.dailyContext) {
          this.sendJson(res, 503, { error: "Daily context manager not available" });
          return;
        }
        const body = await readJsonBody<{ forceExtraction?: boolean }>(req);
        const result = await this.dailyContext.triggerNow(body?.forceExtraction === true);
        this.sendJson(res, 200, result);
        return;
      }

      this.sendJson(res, 404, { error: "Memory endpoint not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ApiServer] Memory request failed:", message);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async handleSessionRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<void> {
    if (!this.sessionManager) {
      this.sendJson(res, 503, { error: "Session manager not available" });
      return;
    }

    try {
      // GET /session — show session info
      if (path === "/session" && req.method === "GET") {
        const info = await this.sessionManager.getSessionInfo();
        this.sendJson(res, 200, info);
        return;
      }

      // POST /session/new — archive current session and start fresh
      if (path === "/session/new" && req.method === "POST") {
        const result = await this.sessionManager.archiveAndStartNew();
        if (result.error) {
          this.sendJson(res, 500, { ok: false, error: result.error });
        } else {
          this.sendJson(res, 200, { ok: true, archived: result.archived });
        }
        return;
      }

      this.sendJson(res, 404, { error: "Session endpoint not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ApiServer] Session request failed:", message);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async handleTaskRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    requestUrl: URL
  ): Promise<void> {
    if (!this.taskStore || !this.taskScheduler) {
      this.sendJson(res, 503, { error: "Task scheduler not available" });
      return;
    }

    try {
      const parts = path.split("/").filter(Boolean);
      const taskId = parts[2];
      const subresource = parts[3];

      if (path === "/api/tasks" && req.method === "GET") {
        this.sendJson(res, 200, { tasks: this.taskStore.listTasks() });
        return;
      }

      if (path === "/api/tasks" && req.method === "POST") {
        const body = await readJsonBody<CreateTaskInput>(req);
        const task = this.taskStore.createTask(body);
        this.taskScheduler.refreshTask(task.id);
        this.sendJson(res, 201, { task: this.taskStore.getTask(task.id) });
        return;
      }

      if (!taskId) {
        this.sendJson(res, 404, { error: "Task endpoint not found" });
        return;
      }

      if (subresource === undefined && req.method === "GET") {
        this.sendJson(res, 200, { task: this.taskStore.getTask(taskId) });
        return;
      }

      if (subresource === undefined && req.method === "PATCH") {
        const body = await readJsonBody<UpdateTaskInput>(req);
        const task = this.taskStore.updateTask(taskId, body);
        this.taskScheduler.refreshTask(task.id);
        this.sendJson(res, 200, { task: this.taskStore.getTask(task.id) });
        return;
      }

      if (subresource === undefined && req.method === "DELETE") {
        this.taskScheduler.removeTask(taskId);
        this.taskStore.deleteTask(taskId);
        this.sendJson(res, 200, { ok: true });
        return;
      }

      if (subresource === "runs" && req.method === "GET") {
        const limit = Number(requestUrl.searchParams.get("limit") ?? 25);
        this.sendJson(res, 200, { runs: this.taskStore.listRuns(taskId, limit) });
        return;
      }

      if (subresource === "run" && req.method === "POST") {
        const run = await this.taskScheduler.runNow(taskId);
        this.sendJson(res, 200, { run });
        return;
      }

      this.sendJson(res, 404, { error: "Task endpoint not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : 400;
      console.error("[ApiServer] Task request failed:", message);
      this.sendJson(res, status, { error: message });
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(body, null, 2));
  }

  private expandHome(pathValue: string): string {
    return pathValue.startsWith("~/")
      ? pathValue.replace("~", process.env.HOME || "/")
      : pathValue;
  }

  private isAllowedPath(fullPath: string): boolean {
    if (this.allowedRoots.length === 0) {
      return false;
    }
    return this.allowedRoots.some((root) =>
      fullPath === root || fullPath.startsWith(`${root}${sep}`)
    );
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
