import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, badRequest, notFound } from "@/lib/api";
import { chatEditFile } from "@/lib/pipeline/orchestrator";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const schema = z.object({ message: z.string().trim().min(1).max(4000) });

/** Chat with Claude Opus to edit a single file — streamed as Server-Sent Events. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  const { id, fileId } = await params;
  const [plugin] = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.userId, user.id)))
    .limit(1);
  if (!plugin) return notFound("Plugin not found");

  const body = schema.safeParse(await req.json());
  if (!body.success) return badRequest("A message is required.");
  const message = body.data.message;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(`: ping\n\n`)), 15000);
      try {
        const result = await chatEditFile(plugin, user, fileId, message, (text) => send({ type: "delta", text }));
        send({ type: "done", ...result });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
