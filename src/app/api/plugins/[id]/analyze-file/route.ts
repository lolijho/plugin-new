import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, notFound, serverError } from "@/lib/api";
import { analyzeFile } from "@/lib/pipeline/orchestrator";
import { streamFileAction } from "@/lib/pipeline/file-stream";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const schema = z.object({ path: z.string().min(1) });

/** Re-review + re-validate an already-created file without changing its code. */
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

    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest("A file path is required.");

    return streamFileAction((emit) => analyzeFile(plugin, user, body.data.path, emit));
  } catch (err) {
    return serverError(err);
  }
}
