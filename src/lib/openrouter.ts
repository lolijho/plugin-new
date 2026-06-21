import "server-only";

const BASE_URL = "https://openrouter.ai/api/v1";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** When provided, enables strict JSON-schema structured output. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  apiKey?: string;
  signal?: AbortSignal;
};

export type ChatResult = {
  content: string;
  usage: Usage;
  model: string;
};

function resolveKey(override?: string): string {
  const key = override || process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OpenRouter API key missing. Set OPENROUTER_API_KEY or add one in Settings.",
    );
  }
  return key;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://wp-plugin-forge.local",
    "X-Title": process.env.OPENROUTER_APP_NAME || "WP Plugin Forge",
  };
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = resolveKey(opts.apiKey);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    usage: { include: true },
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: opts.jsonSchema.name,
        strict: true,
        schema: opts.jsonSchema.schema,
      },
    };
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter error ${res.status} for model "${opts.model}": ${text.slice(0, 600)}`,
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    model?: string;
  };

  const content = json.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error(`OpenRouter returned an empty completion for "${opts.model}".`);
  }

  return {
    content,
    model: json.model ?? opts.model,
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      costUsd: json.usage?.cost ?? 0,
    },
  };
}

/** chat() that parses the JSON content. Tolerant of code-fences / stray prose. */
export async function chatJson<T>(opts: ChatOptions): Promise<{ data: T; usage: Usage; model: string }> {
  const result = await chat(opts);
  const data = parseJsonLoose<T>(result.content);
  return { data, usage: result.usage, model: result.model };
}

/** Streaming chat (plain text). Calls onDelta for each token; returns the full text + usage. */
export async function chatStream(
  opts: ChatOptions,
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  const apiKey = resolveKey(opts.apiKey);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    stream: true,
    usage: { include: true },
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error ${res.status} for model "${opts.model}": ${text.slice(0, 600)}`);
  }
  if (!res.body) throw new Error("OpenRouter returned no stream body.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let model = opts.model;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        model?: string;
      };
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta(delta);
      }
      if (j.usage) {
        usage.promptTokens = j.usage.prompt_tokens ?? 0;
        usage.completionTokens = j.usage.completion_tokens ?? 0;
        usage.costUsd = j.usage.cost ?? 0;
      }
      if (j.model) model = j.model;
    }
  }

  return { content, usage, model };
}

export function parseJsonLoose<T>(raw: string): T {
  let text = raw.trim();
  // Strip ```json fences if a model added them despite structured output.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall back to the first balanced JSON object/array in the string.
    const start = text.search(/[{[]/);
    if (start >= 0) {
      const slice = text.slice(start);
      try {
        return JSON.parse(slice) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Model did not return valid JSON. Got: ${raw.slice(0, 300)}`);
  }
}

export type OpenRouterModel = {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
};

export async function listModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const key = resolveKey(apiKey);
  const res = await fetch(`${BASE_URL}/models`, { headers: headers(key) });
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenRouter models (${res.status}).`);
  }
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  return (json.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}
