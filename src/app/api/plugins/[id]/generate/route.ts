import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, plugins } from "@/db";
import { authed, notFound } from "@/lib/api";
import { generatePlugin, type RunEvent } from "@/lib/pipeline/orchestrator";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

/**
 * Streams the code → review → validate → autofix run as Server-Sent Events.
 * The client reads it with fetch()+getReader() (not EventSource) so a dropped
 * connection does not auto-restart the generation.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const [plugin] = await db
    .select()
    .from(plugins)
    .where(and(eq(plugins.id, id), eq(plugins.userId, user.id)))
    .limit(1);
  if (!plugin) return notFound("Plugin not found");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: RunEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Heartbeat keeps proxies from closing the connection during long LLM calls.
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);
      try {
        await generatePlugin(plugin, user, send);
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
