import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, memoryEntries } from "@/db";
import { authed, json, serverError } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authed();
    if (user instanceof NextResponse) return user;
    const { id } = await params;
    await db
      .delete(memoryEntries)
      .where(and(eq(memoryEntries.id, id), eq(memoryEntries.userId, user.id)));
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
