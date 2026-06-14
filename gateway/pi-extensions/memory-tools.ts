/**
 * Memory Tools Extension
 *
 * Thin Pi tool wrapper around the Gateway-owned memory API.
 * Gateway owns SQLite, sqlite-vec, FTS, and Ollama embedding.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const GATEWAY_MEMORY_BASE_URL =
  process.env.MEMORY_GATEWAY_URL ||
  `http://127.0.0.1:${process.env.FILE_SERVER_PORT || "3457"}`;

type MemoryWriteParams = {
  content: string;
  kind?: string;
  scope?: "user" | "project" | "daily" | "session";
  importance?: number;
  project?: string;
  source?: string;
  sourceId?: string;
};

type MemorySearchParams = {
  query: string;
  kind?: string;
  scope?: string;
  project?: string;
  limit?: number;
};

export default function registerMemoryTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search the user's SQLite memory using hybrid vector + full-text search. " +
      "Use when you need to recall preferences, facts, past decisions, project context, or recent notes.",
    promptSnippet: "Hybrid semantic + keyword memory search",
    promptGuidelines: [
      "Use memory_search when prior context would materially improve the answer.",
      "Prefer specific queries with names, projects, dates, or concepts.",
      "Do not guess remembered facts if memory_search can verify them.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language or keyword query to search memory.",
      }),
      kind: Type.Optional(
        Type.String({
          description: "Optional kind filter: preference, fact, project, decision, task, admin, note.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description: "Optional scope filter: user, project, daily, session.",
        }),
      ),
      project: Type.Optional(
        Type.String({
          description: "Optional project name filter.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum results to return. Default 10, max 50.",
        }),
      ),
    }),

    async execute(_toolCallId, params: MemorySearchParams) {
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "'query' is required." }],
          isError: true,
        };
      }

      const response = await gatewayJson<{ results: unknown[] }>("/memory/search", {
        query,
        kind: params.kind,
        scope: params.scope,
        project: params.project,
        limit: params.limit,
      });

      return {
        content: [
          {
            type: "text",
            text: formatSearchResults(query, response.results),
          },
        ],
        details: response,
      };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Save a concise memory through the Gateway SQLite memory store. " +
      "Use for durable user facts, preferences, decisions, active project context, and important recent notes.",
    promptSnippet: "Write structured memory to Gateway SQLite",
    promptGuidelines: [
      "Write only information that would help future sessions; do not log routine chatter.",
      "Use scope='user' for stable personal facts/preferences, scope='project' for project decisions, and scope='daily' for recent notes.",
      "Set importance 4-5 only for facts that should appear in startup context.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description: "Concise memory text. Include enough context to stand alone.",
      }),
      kind: Type.Optional(
        Type.String({
          description: "Kind: preference, fact, project, decision, task, admin, note. Default note.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          description: "Scope: user, project, daily, session. Default daily.",
        }),
      ),
      importance: Type.Optional(
        Type.Number({
          description: "Importance from 1-5. Use 4-5 for startup-briefing-worthy memories.",
        }),
      ),
      project: Type.Optional(
        Type.String({
          description: "Project name when scope/kind relates to a project.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "Optional source label, e.g. pi-tool, user-request, session.",
        }),
      ),
      sourceId: Type.Optional(
        Type.String({
          description: "Optional source id, e.g. session/message id.",
        }),
      ),
    }),

    async execute(_toolCallId, params: MemoryWriteParams) {
      const content = params.content?.trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "'content' is required." }],
          isError: true,
        };
      }

      const response = await gatewayJson<{ memory: Record<string, unknown> }>("/memory/write", {
        content,
        kind: params.kind,
        scope: params.scope,
        importance: params.importance,
        project: params.project,
        source: params.source || "pi-tool",
        sourceId: params.sourceId,
      });

      const memory = response.memory;
      const embeddingStatus = memory.embeddingStatus
        ? ` embedding=${String(memory.embeddingStatus)}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Saved memory #${String(memory.id)}.${embeddingStatus}`,
          },
        ],
        details: response,
      };
    },
  });
}

async function gatewayJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY_MEMORY_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text };
  }

  if (!response.ok) {
    const error =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Gateway memory API failed with HTTP ${response.status}`;
    throw new Error(error);
  }

  return parsed as T;
}

function formatSearchResults(query: string, results: unknown[]): string {
  if (results.length === 0) {
    return `No memory results for "${query}".`;
  }

  const lines = [`Memory results for "${query}":`, ""];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const result = item as Record<string, unknown>;
    const id = result.id;
    const kind = result.kind;
    const scope = result.scope;
    const score =
      typeof result.score === "number" ? ` score=${result.score.toFixed(3)}` : "";
    const content = String(result.content ?? "").trim();
    lines.push(`- #${String(id)} (${String(kind)}/${String(scope)}${score}) ${content}`);
  }
  return lines.join("\n");
}
