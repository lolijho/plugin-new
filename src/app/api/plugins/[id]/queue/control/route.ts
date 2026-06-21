import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins, jobs } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";

const schema = z.object({
  action: z.enum(["pause", "resume", "clear", "remove", "retry"]),
  jobId: z.string().optional(),
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

    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest("Invalid control payload");
    const { action, jobId } = body.data;

    switch (action) {
      case "pause":
        await db.update(plugins).set({ queuePaused: true }).where(eq(plugins.id, id));
        break;
      case "resume":
        await db.update(plugins).set({ queuePaused: false }).where(eq(plugins.id, id));
        break;
      case "clear":
        // Drop everything not actively running (queued + failed).
        await db.delete(jobs).where(and(eq(jobs.pluginId, id), inArray(jobs.status, ["queued", "failed"])));
        break;
      case "remove":
        if (!jobId) return badRequest("jobId required");
        await db.delete(jobs).where(and(eq(jobs.id, jobId), eq(jobs.pluginId, id), inArray(jobs.status, ["queued", "failed"])));
        break;
      case "retry":
        if (!jobId) return badRequest("jobId required");
        await db
          .update(jobs)
          .set({ status: "queued", error: null, progress: 0, label: null, startedAt: null, finishedAt: null })
          .where(and(eq(jobs.id, jobId), eq(jobs.pluginId, id), eq(jobs.status, "failed")));
        break;
    }

    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
