import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, notFound, serverError } from "@/lib/api";
import { pluginManifestSchema } from "@/lib/types";
import { slugify } from "@/lib/pipeline/architect";

/** Save an edited manifest (the user's checkpoint edits) and mark it approved. */
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

    const parsed = pluginManifestSchema.safeParse((await req.json())?.manifest);
    if (!parsed.success) return badRequest("Invalid manifest: " + parsed.error.issues[0]?.message);

    const manifest = parsed.data;
    manifest.slug = slugify(manifest.slug || manifest.name);
    if (!manifest.textDomain) manifest.textDomain = manifest.slug;

    await db
      .update(plugins)
      .set({
        manifest,
        name: manifest.name,
        slug: manifest.slug,
        description: manifest.description,
        status: "awaiting_approval",
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, id));

    return json({ manifest });
  } catch (err) {
    return serverError(err);
  }
}
