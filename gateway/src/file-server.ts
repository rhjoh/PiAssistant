import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { lookup } from "mime-types";
import type { StatusProvider } from "./status-types.js";

/**
 * Simple HTTP file server for serving local images to web UI clients.
 * Runs on a separate port from the WebSocket server.
 */
export class FileServer {
  private server: ReturnType<typeof createServer> | null = null;
  private readonly allowedRoots: string[];
  private statusProvider: StatusProvider | null = null;

  constructor(
    private port: number = 3457,
    allowedRoots: string[] = [],
    private wsPort: number = 3456
  ) {
    this.allowedRoots = allowedRoots.map((root) => resolve(this.expandHome(root)));
  }

  setStatusProvider(provider: StatusProvider): void {
    this.statusProvider = provider;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err) => {
        console.error(`[FileServer] Error:`, err);
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[FileServer] Serving files at http://127.0.0.1:${this.port}`);
        if (this.allowedRoots.length > 0) {
          console.log(`[FileServer] Allowed roots: ${this.allowedRoots.join(", ")}`);
        }
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    console.log("[FileServer] Stopped");
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    // Status endpoint
    if (url === "/status" && req.method === "GET") {
      this.handleStatusRequest(res);
      return;
    }

    // Only serve /files/* paths
    if (!url.startsWith("/files/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Extract path and resolve safely
    const filePath = decodeURIComponent(url.slice("/files/".length));

    // Security: only allow absolute paths
    if (!filePath.startsWith("/") && !filePath.startsWith("~/")) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: only absolute paths allowed");
      return;
    }

    // Expand ~ to home directory
    const resolvedPath = this.expandHome(filePath);

    // Security: prevent directory traversal
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

    const stats = statSync(fullPath);
    if (!stats.isFile()) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: not a file");
      return;
    }

    // Set content type based on extension
    const contentType = lookup(extname(fullPath)) || "application/octet-stream";

    // Stream the file
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "public, max-age=3600",
    });

    const stream = createReadStream(fullPath);
    stream.pipe(res);

    stream.on("error", (err) => {
      console.error(`[FileServer] Error streaming ${fullPath}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    });
  }

  private handleStatusRequest(res: ServerResponse): void {
    if (!this.statusProvider) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Status not available" }));
      return;
    }

    const status = this.statusProvider.getStatus();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(status, null, 2));
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
