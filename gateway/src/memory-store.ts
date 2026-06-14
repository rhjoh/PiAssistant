import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EmbeddingClient } from "./memory-embeddings.js";

export type MemoryScope = "user" | "project" | "daily" | "session";

export interface MemoryRecord {
  id: number;
  content: string;
  kind: string;
  scope: string;
  importance: number;
  project: string | null;
  source: string | null;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  accessCount: number;
  embeddingStatus: string;
  embeddingError: string | null;
}

export interface MemorySearchResult extends MemoryRecord {
  score: number;
  matchType: "vector" | "fts" | "hybrid";
  distance?: number;
}

export interface WriteMemoryInput {
  content: string;
  kind?: string;
  scope?: MemoryScope;
  importance?: number;
  project?: string | null;
  source?: string | null;
  sourceId?: string | null;
}

export interface SearchMemoryInput {
  query: string;
  limit?: number;
  kind?: string;
  scope?: string;
  project?: string;
}

type DbMemoryRow = {
  id: number;
  content: string;
  kind: string;
  scope: string;
  importance: number;
  project: string | null;
  source: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  access_count: number;
  embedding_status: string;
  embedding_error: string | null;
};

export class MemoryStore {
  private db: Database.Database | null = null;

  constructor(
    private options: {
      dbPath: string;
      embeddingClient: EmbeddingClient;
      briefingPath: string;
    }
  ) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.options.dbPath), { recursive: true });
    const db = new Database(this.options.dbPath);
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    this.db = db;
    this.migrate();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async writeMemory(input: WriteMemoryInput): Promise<MemoryRecord> {
    const db = this.requireDb();
    const content = input.content.trim();
    if (!content) {
      throw new Error("content is required");
    }

    const now = new Date().toISOString();
    const kind = normalizeLabel(input.kind, "note");
    const scope = normalizeScope(input.scope);
    const importance = clampImportance(input.importance);
    const project = cleanOptional(input.project);
    const source = cleanOptional(input.source);
    const sourceId = cleanOptional(input.sourceId);

    const insert = db.prepare(`
      INSERT INTO memories (
        content, kind, scope, importance, project, source, source_id,
        created_at, updated_at, embedding_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);

    const result = insert.run(
      content,
      kind,
      scope,
      importance,
      project,
      source,
      sourceId,
      now,
      now
    );
    const id = Number(result.lastInsertRowid);

    try {
      const embedding = await this.options.embeddingClient.embed(content);
      this.ensureVectorTable(embedding.length);
      db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(BigInt(id));
      db.prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(
        BigInt(id),
        JSON.stringify(embedding)
      );
      db.prepare(`
        UPDATE memories
        SET embedding_status = 'ready', embedding_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`
        UPDATE memories
        SET embedding_status = 'pending', embedding_error = ?, updated_at = ?
        WHERE id = ?
      `).run(message.slice(0, 500), new Date().toISOString(), id);
      console.warn(`[MemoryStore] Memory ${id} saved without embedding: ${message}`);
    }

    return this.getMemory(id);
  }

  async searchMemory(input: SearchMemoryInput): Promise<MemorySearchResult[]> {
    const db = this.requireDb();
    const query = input.query.trim();
    if (!query) return [];

    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const merged = new Map<number, MemorySearchResult>();

    await this.addVectorSearchResults(merged, query, limit, input);
    this.addFtsSearchResults(merged, query, limit, input);

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score || b.importance - a.importance)
      .slice(0, limit);

    if (results.length > 0) {
      const now = new Date().toISOString();
      const update = db.prepare(`
        UPDATE memories
        SET access_count = access_count + 1, last_seen_at = ?
        WHERE id = ?
      `);
      const transaction = db.transaction((ids: number[]) => {
        for (const id of ids) update.run(now, id);
      });
      transaction(results.map((result) => result.id));
    }

    return results;
  }

  async backfillEmbeddings(limit = 100): Promise<{ processed: number; ready: number; failed: number }> {
    const db = this.requireDb();
    const rows = this.queryRows(`
      SELECT * FROM memories
      WHERE archived = 0 AND embedding_status != 'ready'
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `, [Math.max(1, Math.min(limit, 1000))]);

    let ready = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const embedding = await this.options.embeddingClient.embed(row.content);
        this.ensureVectorTable(embedding.length);
        db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(BigInt(row.id));
        db.prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(
          BigInt(row.id),
          JSON.stringify(embedding)
        );
        db.prepare(`
          UPDATE memories
          SET embedding_status = 'ready', embedding_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), row.id);
        ready++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`
          UPDATE memories
          SET embedding_status = 'failed', embedding_error = ?, updated_at = ?
          WHERE id = ?
        `).run(message.slice(0, 500), new Date().toISOString(), row.id);
        failed++;
      }
    }

    return { processed: rows.length, ready, failed };
  }

  buildBriefing(options: { project?: string; maxItems?: number } = {}): string {
    const maxItems = Math.max(5, Math.min(options.maxItems ?? 40, 100));
    const project = cleanOptional(options.project);
    const selected = new Map<number, MemoryRecord>();

    const addRows = (rows: DbMemoryRow[]) => {
      for (const row of rows) {
        if (selected.size >= maxItems) break;
        selected.set(row.id, mapMemoryRow(row));
      }
    };

    addRows(this.queryRows(`
      SELECT * FROM memories
      WHERE archived = 0 AND scope = 'user'
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `, [Math.ceil(maxItems * 0.35)]));

    if (project) {
      addRows(this.queryRows(`
        SELECT * FROM memories
        WHERE archived = 0 AND (project = ? OR scope = 'project')
        ORDER BY importance DESC, updated_at DESC
        LIMIT ?
      `, [project, Math.ceil(maxItems * 0.25)]));
    }

    addRows(this.queryRows(`
      SELECT * FROM memories
      WHERE archived = 0
      ORDER BY updated_at DESC
      LIMIT ?
    `, [Math.ceil(maxItems * 0.25)]));

    addRows(this.queryRows(`
      SELECT * FROM memories
      WHERE archived = 0 AND access_count > 0
      ORDER BY access_count DESC, last_seen_at DESC
      LIMIT ?
    `, [Math.ceil(maxItems * 0.15)]));

    const records = Array.from(selected.values()).slice(0, maxItems);
    const byScope = groupBy(records, (record) => record.scope);

    const lines = [
      "# Memory Briefing",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      "This is a compact generated view of SQLite memory. Use memory_search for anything not shown here.",
      "",
    ];

    appendSection(lines, "User", byScope.get("user"));
    appendSection(lines, "Project", byScope.get("project"));
    appendSection(lines, "Recent / Daily", [
      ...(byScope.get("daily") ?? []),
      ...(byScope.get("session") ?? []),
    ]);

    if (records.length === 0) {
      lines.push("No memories stored yet.", "");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  async writeBriefingFile(options: { project?: string; maxItems?: number } = {}): Promise<void> {
    await mkdir(dirname(this.options.briefingPath), { recursive: true });
    await writeFile(this.options.briefingPath, this.buildBriefing(options), "utf8");
  }

  private migrate(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        scope TEXT NOT NULL DEFAULT 'daily',
        importance INTEGER NOT NULL DEFAULT 3,
        project TEXT,
        source TEXT,
        source_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        embedding_status TEXT NOT NULL DEFAULT 'pending',
        embedding_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_scope_importance
        ON memories(scope, importance DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_project
        ON memories(project, importance DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_updated
        ON memories(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        kind,
        scope,
        project,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, kind, scope, project)
        VALUES (new.id, new.content, new.kind, new.scope, new.project);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, kind, scope, project)
        VALUES('delete', old.id, old.content, old.kind, old.scope, old.project);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, kind, scope, project)
        VALUES('delete', old.id, old.content, old.kind, old.scope, old.project);
        INSERT INTO memories_fts(rowid, content, kind, scope, project)
        VALUES (new.id, new.content, new.kind, new.scope, new.project);
      END;
    `);

    // Rebuild FTS index only when empty (first creation or after corruption).
    // The triggers keep FTS in sync for all writes, so rebuild is not needed
    // on every startup -- only when the FTS table has no rows.
    const ftsRowCount = db.prepare("SELECT count(*) as cnt FROM memories_fts").get() as { cnt: number };
    if (ftsRowCount.cnt === 0) {
      console.log("[MemoryStore] Rebuilding FTS index (empty FTS table)");
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
    }
  }

  private async addVectorSearchResults(
    merged: Map<number, MemorySearchResult>,
    query: string,
    limit: number,
    filters: SearchMemoryInput
  ): Promise<void> {
    const db = this.requireDb();
    if (!this.hasVectorTable()) return;

    let embedding: number[];
    try {
      embedding = await this.options.embeddingClient.embed(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MemoryStore] Vector search skipped: ${message}`);
      return;
    }

    const rows = db.prepare(`
      SELECT rowid AS id, distance
      FROM memory_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(JSON.stringify(embedding), limit * 3) as { id: number; distance: number }[];

    for (const row of rows) {
      const memory = this.getMemoryOrNull(row.id);
      if (!memory || !matchesFilters(memory, filters)) continue;
      const score = 1 / (1 + row.distance) + memory.importance * 0.03;
      mergeResult(merged, {
        ...memory,
        score,
        matchType: "vector",
        distance: row.distance,
      });
    }
  }

  private addFtsSearchResults(
    merged: Map<number, MemorySearchResult>,
    query: string,
    limit: number,
    filters: SearchMemoryInput
  ): void {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return;

    const clauses = ["memories_fts MATCH ?", "m.archived = 0"];
    const params: unknown[] = [ftsQuery];
    if (filters.kind) {
      clauses.push("m.kind = ?");
      params.push(filters.kind);
    }
    if (filters.scope) {
      clauses.push("m.scope = ?");
      params.push(filters.scope);
    }
    if (filters.project) {
      clauses.push("m.project = ?");
      params.push(filters.project);
    }
    params.push(limit * 3);

    const rows = this.queryRows(`
      SELECT m.*
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY bm25(memories_fts), m.importance DESC, m.updated_at DESC
      LIMIT ?
    `, params);

    let rank = 0;
    for (const row of rows) {
      const memory = mapMemoryRow(row);
      const score = 0.75 - rank * 0.02 + memory.importance * 0.04;
      mergeResult(merged, {
        ...memory,
        score,
        matchType: "fts",
      });
      rank++;
    }
  }

  private ensureVectorTable(dimension: number): void {
    const db = this.requireDb();
    const existingDimension = this.getMeta("embedding_dimension");
    if (existingDimension) {
      const parsed = Number(existingDimension);
      if (parsed !== dimension) {
        throw new Error(`Embedding dimension changed from ${parsed} to ${dimension}`);
      }
    }

    if (!this.hasVectorTable()) {
      db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[${dimension}])`);
      this.setMeta("embedding_dimension", String(dimension));
    }
  }

  private hasVectorTable(): boolean {
    const db = this.requireDb();
    const row = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'memory_vec'
    `).get();
    return Boolean(row);
  }

  private getMemory(id: number): MemoryRecord {
    const memory = this.getMemoryOrNull(id);
    if (!memory) throw new Error(`Memory ${id} not found`);
    return memory;
  }

  private getMemoryOrNull(id: number): MemoryRecord | null {
    const row = this.requireDb()
      .prepare("SELECT * FROM memories WHERE id = ? AND archived = 0")
      .get(id) as DbMemoryRow | undefined;
    return row ? mapMemoryRow(row) : null;
  }

  private queryRows(sql: string, params: unknown[] = []): DbMemoryRow[] {
    return this.requireDb().prepare(sql).all(...params) as DbMemoryRow[];
  }

  private getMeta(key: string): string | null {
    const row = this.requireDb()
      .prepare("SELECT value FROM memory_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.requireDb()
      .prepare("INSERT INTO memory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error("MemoryStore is not initialized");
    }
    return this.db;
  }
}

function mapMemoryRow(row: DbMemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    scope: row.scope,
    importance: row.importance,
    project: row.project,
    source: row.source,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    accessCount: row.access_count,
    embeddingStatus: row.embedding_status,
    embeddingError: row.embedding_error,
  };
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const cleaned = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_");
  return cleaned || fallback;
}

function normalizeScope(value: MemoryScope | undefined): MemoryScope {
  if (value === "user" || value === "project" || value === "daily" || value === "session") {
    return value;
  }
  return "daily";
}

function clampImportance(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(5, Math.round(value ?? 3)));
}

function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function buildFtsQuery(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8)
    .map((term) => `${term.replace(/"/g, "")}*`)
    .join(" OR ");
}

function matchesFilters(memory: MemoryRecord, filters: SearchMemoryInput): boolean {
  if (filters.kind && memory.kind !== filters.kind) return false;
  if (filters.scope && memory.scope !== filters.scope) return false;
  if (filters.project && memory.project !== filters.project) return false;
  return true;
}

function mergeResult(merged: Map<number, MemorySearchResult>, result: MemorySearchResult): void {
  const existing = merged.get(result.id);
  if (!existing) {
    merged.set(result.id, result);
    return;
  }

  existing.score += result.score;
  existing.matchType = "hybrid";
  if (result.distance !== undefined) {
    existing.distance = result.distance;
  }
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function appendSection(lines: string[], title: string, records: MemoryRecord[] | undefined): void {
  if (!records?.length) return;
  lines.push(`## ${title}`);
  for (const record of records) {
    const tags = [`${record.kind}`, `importance:${record.importance}`];
    if (record.project) tags.push(`project:${record.project}`);
    lines.push(`- (${tags.join(", ")}) ${record.content}`);
  }
  lines.push("");
}
