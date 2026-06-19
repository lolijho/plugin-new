import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, memoryEntries } from "@/db";
import { authed, badRequest, json, serverError } from "@/lib/api";
import { retrieveMemory, storeMemory } from "@/lib/memory";

export async function GET(req: Request) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const q = new URL(req.url).searchParams.get("q")?.trim();

    if (q) {
      const results = await retrieveMemory({ userId: user.id, query: q, limit: 20 });
      return json({ entries: results, search: true });
    }
    const rows = await db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.userId, user.id))
      .orderBy(desc(memoryEntries.importance), desc(memoryEntries.createdAt))
      .limit(200);
    return json({ entries: rows, search: false });
  } catch (err) {
    return serverError(err);
  }
}

const schema = z.object({
  kind: z.enum(["lesson", "error", "pattern", "preference", "snippet"]).default("lesson"),
  title: z.string().trim().min(3).max(300),
  content: z.string().trim().min(3).max(8000),
  tags: z.array(z.string()).max(20).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const body = schema.safeParse(await req.json());
    if (!body.success) return badRequest(body.error.issues[0]?.message ?? "Invalid input");
    await storeMemory({
      userId: user.id,
      kind: body.data.kind,
      title: body.data.title,
      content: body.data.content,
      tags: body.data.tags ?? [],
      importance: 2,
    });
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
