import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { updateFileContent } from "@/lib/pipeline/orchestrator";

export const maxDuration = 60;

const schema = z.object({ content: z.string() });

/** Save a manually-edited file's content. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
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
    if (!body.success) return badRequest("content is required");

    const result = await updateFileContent(plugin, user, fileId, body.data.content);
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
