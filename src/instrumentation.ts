// Runs once when the Next.js server process boots. We use it to start the
// background queue worker so file generation keeps running server-side,
// independent of any browser/client connection.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("@/lib/pipeline/worker");
    startWorker();
  }
}
