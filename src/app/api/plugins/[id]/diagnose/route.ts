import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { diagnosePlugin } from "@/lib/pipeline/orchestrator";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const schema = z.object({ errorText: z.string().trim().max(5000).optional() });

/** Whole-plugin diagnosis: find the root cause of a critical/fatal error. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.id, id), eq(plugins.userId, user.id)))
      .limit(1);
    if (!plugin) return notFound("Plugin not found");

    const body = schema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return badRequest("Invalid input");

    const result = await diagnosePlugin(plugin, user, body.data.errorText);
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
