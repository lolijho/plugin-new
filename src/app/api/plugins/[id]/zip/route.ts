import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins, pluginFiles } from "@/db";
import { authed, notFound, badRequest } from "@/lib/api";
import { buildPluginZip } from "@/lib/zip";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  const { id } = await params;

  const [plugin] = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.userId, user.id)))
    .limit(1);
  if (!plugin) return notFound("Plugin not found");

  const files = await db
    .select({ path: pluginFiles.path, content: pluginFiles.content })
    .from(pluginFiles)
    .where(eq(pluginFiles.pluginId, id))
    .orderBy(asc(pluginFiles.path));

  if (files.length === 0) return badRequest("No generated files to download yet.");

  const slug = plugin.slug || "plugin";
  const zip = await buildPluginZip(slug, files);

  return new Response(Buffer.from(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Content-Length": String(zip.byteLength),
    },
  });
}
