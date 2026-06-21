import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { chatEditFile } from "@/lib/pipeline/orchestrator";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const schema = z.object({ message: z.string().trim().min(1).max(4000) });

/** Chat with Claude Opus to edit a single file. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id, fileId } = await params;
    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.id, id), eq(plugins.userId, user.id)))
      .limit(1);
    if (!plugin) return notFound("Plugin not found");

    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest("A message is required.");

    const result = await chatEditFile(plugin, user, fileId, body.data.message);
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
