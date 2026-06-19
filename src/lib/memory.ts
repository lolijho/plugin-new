import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { memoryEntries } from "@/db/schema";
import { embed, embeddingsEnabled, toVectorLiteral } from "./embeddings";

export type MemoryKind = "lesson" | "error" | "pattern" | "preference" | "snippet";

export type StoreMemoryInput = {
  userId: string;
  pluginId?: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  sourceGenerationId?: string | null;
};

export type RetrievedMemory = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  score: number;
};

/** Store a memory entry, attaching an embedding when an embeddings provider is configured. */
export async function storeMemory(input: StoreMemoryInput): Promise<void> {
  const text = `${input.title}\n${input.content}`;
  const vector = await embed(text);

  await db.insert(memoryEntries).values({
    userId: input.userId,
    pluginId: input.pluginId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 300),
    content: input.content.slice(0, 8000),
    tags: input.tags ?? [],
    importance: input.importance ?? 1,
    sourceGenerationId: input.sourceGenerationId ?? null,
    embedding: vector ?? null,
  });
}

/** De-duplicate trivially-similar memories before storing (avoids spam). */
export async function storeMemoryDeduped(input: StoreMemoryInput): Promise<void> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM memory_entries
    WHERE user_id = ${input.userId}
      AND kind = ${input.kind}
      AND lower(title) = lower(${input.title.slice(0, 300)})
    LIMIT 1
  `);
  if (existing.length > 0) {
    // Bump importance instead of inserting a duplicate.
    await db.execute(sql`
      UPDATE memory_entries SET importance = importance + 1 WHERE id = ${existing[0].id}
    `);
    return;
  }
  await storeMemory(input);
}

type Row = {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  score: number;
};

/**
 * Retrieve the most relevant memories for a query, scoped to a user (and
 * optionally biased toward a plugin). Uses pgvector cosine search when
 * embeddings are available, otherwise Postgres full-text search, and finally
 * falls back to the most important/recent entries so there is always context.
 */
export async function retrieveMemory(params: {
  userId: string;
  pluginId?: string | null;
  query: string;
  limit?: number;
}): Promise<RetrievedMemory[]> {
  const limit = params.limit ?? 6;
  const { userId, query } = params;

  if (embeddingsEnabled()) {
    const vec = await embed(query);
    if (vec) {
      const literal = toVectorLiteral(vec);
      const rows = await db.execute<Row>(sql`
        SELECT id, kind, title, content, tags, importance,
               1 - (embedding <=> ${literal}::vector) AS score
        FROM memory_entries
        WHERE user_id = ${userId} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${limit}
      `);
      if (rows.length > 0) return rows.map(normalize);
    }
  }

  // Lexical full-text fallback.
  if (query.trim()) {
    const rows = await db.execute<Row>(sql`
      SELECT id, kind, title, content, tags, importance,
             ts_rank(to_tsvector('english', title || ' ' || content),
                     websearch_to_tsquery('english', ${query})) AS score
      FROM memory_entries
      WHERE user_id = ${userId}
        AND to_tsvector('english', title || ' ' || content)
            @@ websearch_to_tsquery('english', ${query})
      ORDER BY score DESC, importance DESC
      LIMIT ${limit}
    `);
    if (rows.length > 0) return rows.map(normalize);
  }

  // Last resort: the most salient entries the user has accumulated.
  const rows = await db.execute<Row>(sql`
    SELECT id, kind, title, content, tags, importance, 0 AS score
    FROM memory_entries
    WHERE user_id = ${userId}
    ORDER BY importance DESC, created_at DESC
    LIMIT ${limit}
  `);
  return rows.map(normalize);
}

function normalize(r: Row): RetrievedMemory {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    tags: Array.isArray(r.tags) ? r.tags : [],
    importance: Number(r.importance ?? 1),
    score: Number(r.score ?? 0),
  };
}

/** Render retrieved memories as a prompt-injectable block. */
export function formatMemoriesForPrompt(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m, i) => {
    const tag = m.kind.toUpperCase();
    return `${i + 1}. [${tag}] ${m.title}\n   ${m.content.replace(/\s+/g, " ").trim().slice(0, 500)}`;
  });
  return [
    "## RELEVANT MEMORY (lessons & past mistakes — apply these, do not repeat past errors)",
    ...lines,
  ].join("\n");
}
