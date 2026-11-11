import { apiRoute } from "@/server/http";
import { pingDatabase } from "@/server/db";
import { env } from "@/server/env";
import { getWorkerStatus } from "@/server/jobs/worker";

export const GET = apiRoute(async () => {
  try {
    const db = await pingDatabase();
    return Response.json({ status: "ok", service: "holdfast", db: db === "connected" ? "ok" : "skipped", paypal_env: "sandbox", app_origin: new URL(env.APP_URL).origin, ai_mode: env.AI_MODE, worker: getWorkerStatus() });
  } catch {
    return Response.json({ status: "degraded", service: "holdfast", db: "unavailable", paypal_env: "sandbox", app_origin: new URL(env.APP_URL).origin, ai_mode: env.AI_MODE, worker: getWorkerStatus() }, { status: 503 });
  }
});
