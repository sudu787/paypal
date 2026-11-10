import { apiRoute } from "@/server/http";
import { pingDatabase } from "@/server/db";
import { env } from "@/server/env";

export const GET = apiRoute(async () => {
  try {
    const db = await pingDatabase();
    return Response.json({ status: "ok", service: "holdfast", db: db === "connected" ? "ok" : "skipped", paypal_env: "sandbox", ai_mode: env.AI_MODE });
  } catch {
    return Response.json({ status: "degraded", service: "holdfast", db: "unavailable", paypal_env: "sandbox", ai_mode: env.AI_MODE }, { status: 503 });
  }
});
