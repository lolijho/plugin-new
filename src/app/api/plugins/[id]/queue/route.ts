import { z } from "zod";
import { and, eq, inArray, asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins, jobs } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { startWorker } from "@/lib/pipeline/worker";

async function getOwned(userId: string, id: string) {
  const [plugin] = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.userId, userId)))
    .limit(1);
  return plugin ?? null;
}

const ACTIONS = ["generate-file", "analyze-file", "fix-file"] as const;
const enqueueSchema = z.object({
  items: z
    .array(z.object({ path: z.string().min(1), action: z.enum(ACTIONS).default("generate-file") }))
    .min(1)
    .max(200),
});

// Enqueue jobs (deduped against pending/running ones).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    const plugin = await getOwned(user.id, id);
    if (!plugin) return notFound("Plugin not found");

    const body = enqueueSchema.safeParse(await req.json());
    if (!body.success) return badRequest("Invalid queue payload");

    const pending = await db
      .select({ path: jobs.path, action: jobs.action })
      .from(jobs)
      .where(and(eq(jobs.pluginId, id), inArray(jobs.status, ["queued", "running"])));
    const seen = new Set(pending.map((j) => `${j.path}|${j.action}`));

    const toInsert = body.data.items
      .filter((it) => !seen.has(`${it.path}|${it.action}`))
      .map((it) => ({ pluginId: id, userId: user.id, path: it.path, action: it.action }));

    if (toInsert.length > 0) {
      await db.insert(jobs).values(toInsert);
    }
    // Make sure the background worker is running (idempotent).
    startWorker();

    return json({ enqueued: toInsert.length });
  } catch (err) {
    return serverError(err);
  }
}

// Live queue state for polling.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    const plugin = await getOwned(user.id, id);
    if (!plugin) return notFound("Plugin not found");

    const rows = await db
      .select({
        id: jobs.id,
        path: jobs.path,
        action: jobs.action,
        status: jobs.status,
        progress: jobs.progress,
        label: jobs.label,
        error: jobs.error,
      })
      .from(jobs)
      .where(and(eq(jobs.pluginId, id), inArray(jobs.status, ["queued", "running", "failed"])))
      .orderBy(asc(jobs.createdAt));

    return json({ paused: plugin.queuePaused, jobs: rows });
  } catch (err) {
    return serverError(err);
  }
}
