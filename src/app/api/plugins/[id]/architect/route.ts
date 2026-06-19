import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { architectPlugin } from "@/lib/pipeline/orchestrator";

export const maxDuration = 300;

const schema = z.object({
  brief: z.string().trim().min(10).optional(),
  revisionNote: z.string().trim().optional(),
});

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

    const brief = body.data.brief || plugin.brief;
    if (!brief || brief.length < 10) return badRequest("A plugin brief is required.");

    const { manifest } = await architectPlugin(plugin, user, {
      brief,
      revisionNote: body.data.revisionNote,
    });
    return json({ manifest });
  } catch (err) {
    return serverError(err);
  }
}
