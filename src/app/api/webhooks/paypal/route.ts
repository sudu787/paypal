import { z } from "zod";
import { getDatabase } from "@/server/db";
import { durableJobs, webhookEvents } from "@/server/db/schema";
import { AppError, toErrorResponse } from "@/server/errors";
import { env } from "@/server/env";
import { verifyWebhookSignature } from "@/server/paypal/client";
import { logger } from "@/server/logger";

const eventSchema = z.object({ id: z.string().min(1).max(255), event_type: z.string().min(1).max(255), resource_type: z.string().optional(), resource: z.record(z.string(), z.unknown()).optional() }).passthrough();

export async function POST(request: Request) {
  const requestId = globalThis.crypto.randomUUID();
  let signatureVerified = false;
  try {
    const raw = await request.text();
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new AppError("VALIDATION_ERROR", "Webhook body must be valid JSON.", 400); }
    const parsed = eventSchema.safeParse(payload);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Webhook event is missing its ID or event type.", 400);
    const event = parsed.data;
    if (!env.PAYPAL_WEBHOOK_SKIP_VERIFY) {
      if (!env.PAYPAL_WEBHOOK_ID) throw new AppError("CONFIGURATION_ERROR", "PayPal webhook verification is not configured.", 503);
      const header = (name: string) => request.headers.get(name) ?? "";
      const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
      if (required.some((name) => !header(name))) throw new AppError("VALIDATION_ERROR", "PayPal signature headers are incomplete.", 400);
      const verified = await verifyWebhookSignature({
        authAlgo: header("paypal-auth-algo"), certUrl: header("paypal-cert-url"), transmissionId: header("paypal-transmission-id"),
        transmissionSig: header("paypal-transmission-sig"), transmissionTime: header("paypal-transmission-time"), webhookId: env.PAYPAL_WEBHOOK_ID, webhookEvent: event,
      });
      if (!verified) throw new AppError("FORBIDDEN", "PayPal webhook signature could not be verified.", 400);
      signatureVerified = true;
    }

    const db = getDatabase();
    if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
    const resource = event.resource ?? {};
    await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(webhookEvents).values({
        id: event.id,
        eventType: event.event_type,
        resourceType: event.resource_type ?? null,
        resourceId: typeof resource.id === "string" ? resource.id : null,
        verified: signatureVerified,
        payload: event,
      }).onConflictDoNothing().returning({ id: webhookEvents.id });
      if (inserted && signatureVerified) await tx.insert(durableJobs).values({ kind: "PAYPAL_WEBHOOK", resourceId: event.id, status: "QUEUED" }).onConflictDoNothing();
    });
    return Response.json({ ok: true });
  } catch (error) {
    logger.error({ requestId, error, event: "paypal_webhook_received" });
    if (error instanceof AppError && error.code === "INTERNAL") return Response.json({ ok: false }, { status: 500 });
    if (!(error instanceof AppError) && !(error instanceof SyntaxError)) return Response.json({ ok: false }, { status: 500 });
    return toErrorResponse(error, requestId);
  }
}
