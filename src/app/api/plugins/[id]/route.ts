import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins, pluginFiles, reviewFindings, messages } from "@/db";
import { authed, json, notFound, serverError } from "@/lib/api";

async function getOwned(userId: string, id: string) {
  const [plugin] = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.userId, userId)))
    .limit(1);
  return plugin ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    const plugin = await getOwned(user.id, id);
    if (!plugin) return notFound("Plugin not found");

    const [files, findings, msgs] = await Promise.all([
      db.select().from(pluginFiles).where(eq(pluginFiles.pluginId, id)).orderBy(asc(pluginFiles.path)),
      db.select().from(reviewFindings).where(eq(reviewFindings.pluginId, id)).orderBy(asc(reviewFindings.severity)),
      db.select().from(messages).where(eq(messages.pluginId, id)).orderBy(asc(messages.createdAt)),
    ]);

    return json({ plugin, files, findings, messages: msgs });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    const plugin = await getOwned(user.id, id);
    if (!plugin) return notFound("Plugin not found");
    await db.delete(plugins).where(eq(plugins.id, id));
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
