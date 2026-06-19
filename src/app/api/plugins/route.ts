import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, json, serverError } from "@/lib/api";
import { slugify } from "@/lib/pipeline/architect";

export async function GET() {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  const rows = await db
    .select()
    .from(plugins)
    .where(eq(plugins.userId, user.id))
    .orderBy(desc(plugins.updatedAt));
  return json({ plugins: rows });
}

const createSchema = z.object({
  name: z.string().trim().max(120).optional(),
  brief: z.string().trim().min(10, "Describe the plugin in at least a sentence."),
});

export async function POST(req: Request) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const body = createSchema.safeParse(await req.json());
    if (!body.success) return badRequest(body.error.issues[0]?.message ?? "Invalid input");

    const name = body.data.name?.trim() || "Untitled plugin";
    const [plugin] = await db
      .insert(plugins)
      .values({
        userId: user.id,
        name,
        slug: slugify(name === "Untitled plugin" ? "my-plugin" : name),
        brief: body.data.brief,
        status: "draft",
      })
      .returning();
    return json({ plugin });
  } catch (err) {
    return serverError(err);
  }
}
