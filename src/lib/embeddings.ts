import "server-only";

/**
 * Embeddings via any OpenAI-compatible endpoint (OpenAI, OpenRouter-compatible
 * providers, local servers…). Optional: when no key is configured the memory
 * layer transparently falls back to Postgres full-text search.
 */
export function embeddingsEnabled(): boolean {
  return Boolean(process.env.EMBEDDINGS_API_KEY);
}

export function embeddingDimensions(): number {
  return Number(process.env.EMBEDDINGS_DIMENSIONS ?? 1536);
}

export async function embed(text: string): Promise<number[] | null> {
  const result = await embedMany([text]);
  return result?.[0] ?? null;
}

export async function embedMany(texts: string[]): Promise<number[][] | null> {
  if (!embeddingsEnabled() || texts.length === 0) return null;

  const baseUrl = process.env.EMBEDDINGS_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.EMBEDDINGS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: texts.map((t) => t.slice(0, 8000)),
      }),
    });
    if (!res.ok) {
      console.error("[embeddings] request failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    return (json.data ?? []).map((d) => d.embedding);
  } catch (err) {
    console.error("[embeddings] error:", err);
    return null;
  }
}

/** Format a JS number[] as a pgvector literal: '[0.1,0.2,...]' */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
