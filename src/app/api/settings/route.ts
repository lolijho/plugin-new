import { z } from "zod";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, users } from "@/db";
import { authed, badRequest, json, serverError } from "@/lib/api";
import { defaultModels } from "@/lib/pipeline/resolve";
import { embeddingsEnabled } from "@/lib/embeddings";
import type { UserSettings } from "@/db/schema";

export async function GET() {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  return json({
    settings: user.settings ?? {},
    defaults: defaultModels(),
    embeddingsEnabled: embeddingsEnabled(),
    hasServerKey: Boolean(process.env.OPENROUTER_API_KEY),
  });
}

const schema = z.object({
  models: z
    .object({
      architect: z.string().optional(),
      coder: z.string().optional(),
      reviewer: z.string().optional(),
    })
    .optional(),
  openrouterApiKey: z.string().optional(),
  temperature: z
    .object({
      architect: z.number().min(0).max(2).optional(),
      coder: z.number().min(0).max(2).optional(),
      reviewer: z.number().min(0).max(2).optional(),
    })
    .optional(),
  autofixIterations: z.number().int().min(0).max(5).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest(body.error.issues[0]?.message ?? "Invalid settings");

    const current = (user.settings ?? {}) as UserSettings;
    const next: UserSettings = {
      ...current,
      ...body.data,
      models: { ...current.models, ...body.data.models },
      temperature: { ...current.temperature, ...body.data.temperature },
    };
    // Empty string clears the stored key (falls back to the server env key).
    if (body.data.openrouterApiKey === "") delete next.openrouterApiKey;

    await db.update(users).set({ settings: next }).where(eq(users.id, user.id));
    return json({ settings: next });
  } catch (err) {
    return serverError(err);
  }
}
