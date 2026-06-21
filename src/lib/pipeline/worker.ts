import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, plugins, users } from "@/db/schema";
import { generateFile, analyzeFile, fixFile, type RunEvent } from "./orchestrator";
import { PHASE } from "./phases";

/**
 * Background queue worker. Runs inside the Node server process (started from
 * instrumentation.ts), so file generation continues even after the user closes
 * the browser or shuts down their computer — the work lives on the server and
 * its state is persisted in the `jobs` table.
 */

const globalForWorker = globalThis as unknown as { __wpforgeWorkerStarted?: boolean };

export function startWorker() {
  if (globalForWorker.__wpforgeWorkerStarted) return;
  globalForWorker.__wpforgeWorkerStarted = true;
  void mainLoop();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mainLoop() {
  // Re-queue jobs that were interrupted by a previous restart.
  try {
    await db
      .update(jobs)
      .set({ status: "queued", startedAt: null, progress: 0, label: null })
      .where(eq(jobs.status, "running"));
  } catch (err) {
    console.error("[worker] reset stale jobs failed:", err);
  }

  console.log("[worker] background queue worker started");
  for (;;) {
    try {
      const job = await claimNext();
      if (!job) {
        await sleep(2000);
        continue;
      }
      await runJob(job);
    } catch (err) {
      console.error("[worker] loop error:", err);
      await sleep(2000);
    }
  }
}

type ClaimedJob = {
  id: string;
  pluginId: string;
  userId: string;
  path: string;
  action: string;
};

/** Atomically claim the oldest queued job whose plugin isn't paused. */
async function claimNext(): Promise<ClaimedJob | null> {
  const rows = await db.execute<ClaimedJob>(sql`
    UPDATE jobs SET status = 'running', started_at = now(), progress = 4
    WHERE id = (
      SELECT j.id FROM jobs j
      JOIN plugins p ON p.id = j.plugin_id
      WHERE j.status = 'queued' AND p.queue_paused = false
      ORDER BY j.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, plugin_id AS "pluginId", user_id AS "userId", path, action
  `);
  return rows[0] ?? null;
}

async function runJob(job: ClaimedJob) {
  const [plugin] = await db.select().from(plugins).where(eq(plugins.id, job.pluginId)).limit(1);
  const [user] = await db.select().from(users).where(eq(users.id, job.userId)).limit(1);
  if (!plugin || !user) {
    await db.update(jobs).set({ status: "canceled", error: "plugin or user missing", finishedAt: new Date() }).where(eq(jobs.id, job.id));
    return;
  }

  // Best-effort progress updates from pipeline phases.
  const emit = (e: RunEvent) => {
    const p = PHASE[e.type];
    if (p) {
      db.update(jobs).set({ progress: p.percent, label: p.label }).where(eq(jobs.id, job.id)).catch(() => {});
    }
  };

  try {
    if (job.action === "analyze-file") await analyzeFile(plugin, user, job.path, emit);
    else if (job.action === "fix-file") await fixFile(plugin, user, job.path, emit);
    else await generateFile(plugin, user, job.path, emit);

    await db.update(jobs).set({ status: "done", progress: 100, label: "Completato", finishedAt: new Date() }).where(eq(jobs.id, job.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${job.id} (${job.action} ${job.path}) failed:`, message);
    await db
      .update(jobs)
      .set({ status: "failed", error: message.slice(0, 1000), label: "Errore", finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
  }
}
