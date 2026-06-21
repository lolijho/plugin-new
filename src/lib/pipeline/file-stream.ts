import "server-only";
import type { RunEvent } from "./orchestrator";

/**
 * Streams a single-file action (create / analyze / fix) as Server-Sent Events,
 * translating pipeline phases into a percentage + label so the UI can show a
 * progress bar while the file is being built.
 */
type StreamEvent =
  | { type: "progress"; percent: number; label: string; path?: string }
  | { type: "result"; result: unknown }
  | { type: "error"; message: string };

const PHASE: Partial<Record<RunEvent["type"], { percent: number; label: string }>> = {
  "file:start": { percent: 8, label: "Preparazione…" },
  "file:coded": { percent: 55, label: "Codice scritto · revisione…" },
  "file:reviewed": { percent: 80, label: "Revisione…" },
  "file:fixed": { percent: 90, label: "Correzione · riverifica…" },
  "file:done": { percent: 98, label: "Salvataggio…" },
};

export function streamFileAction<T>(run: (emit: (e: RunEvent) => void) => Promise<T>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(`: ping\n\n`)), 15000);

      const emit = (e: RunEvent) => {
        const p = PHASE[e.type];
        if (p) send({ type: "progress", percent: p.percent, label: p.label, path: "path" in e ? e.path : undefined });
      };

      try {
        const result = await run(emit);
        send({ type: "result", result });
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
