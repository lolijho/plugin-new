import { NextResponse } from "next/server";
import { authed, json, serverError } from "@/lib/api";
import { listModels, type OpenRouterModel } from "@/lib/openrouter";
import { resolveApiKey } from "@/lib/pipeline/resolve";

// Light in-memory cache (model list changes rarely).
let cache: { at: number; data: OpenRouterModel[] } | null = null;
const TTL = 1000 * 60 * 30;

export async function GET() {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;

    if (cache && Date.now() - cache.at < TTL) {
      return json({ models: cache.data, cached: true });
    }
    const models = await listModels(resolveApiKey(user));
    cache = { at: Date.now(), data: models };
    return json({ models, cached: false });
  } catch (err) {
    return serverError(err);
  }
}
