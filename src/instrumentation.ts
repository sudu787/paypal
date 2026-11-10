export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDurableWorker } = await import("@/server/jobs/worker");
    startDurableWorker();
  }
}
