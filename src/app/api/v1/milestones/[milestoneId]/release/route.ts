import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, captures, deals, milestones, paymentOperations, paypalOrders, submissions } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { PayPalError, captureAuthorization, getAuthorization } from "@/server/paypal/client";

const schema = z.object({ confirm_amount_cents: z.number().int().positive() });

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success || !idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "Confirm the full amount and send a UUID Idempotency-Key.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [snapshot] = await db.select({ milestone: milestones, deal: deals, order: paypalOrders }).from(milestones)
    .innerJoin(deals, eq(milestones.dealId, deals.id)).innerJoin(paypalOrders, eq(paypalOrders.milestoneId, milestones.id))
    .where(and(eq(milestones.id, milestoneId), eq(deals.clientId, user.id), eq(paypalOrders.status, "AUTHORIZED"))).limit(1);
  if (!snapshot) throw new AppError("NOT_FOUND", "No authorized milestone was found for this client.", 404);
  if (snapshot.milestone.authorizationStatus !== "AUTHORIZED" || snapshot.milestone.workStatus !== "SUBMITTED") throw new AppError("CONFLICT", "The milestone needs an active authorization and submitted work before release.", 409);
  if (body.data.confirm_amount_cents !== snapshot.milestone.amountCents || body.data.confirm_amount_cents !== snapshot.order.amountCents) throw new AppError("VALIDATION_ERROR", "Capture amount must exactly match the signed milestone. Partial capture is not enabled.", 400);
  const [latestSubmission] = await db.select().from(submissions).where(eq(submissions.milestoneId, milestoneId)).orderBy(submissions.createdAt).limit(1);
  if (!latestSubmission) throw new AppError("CONFLICT", "A work submission is required before release.", 409);
  const fingerprint = createHash("sha256").update(JSON.stringify({ milestone_id: milestoneId, authorization_id: snapshot.order.authorizationId, amount_cents: body.data.confirm_amount_cents, final_capture: true })).digest("hex");
  const operation = await db.transaction(async (tx) => {
    await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update").limit(1);
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.operationType, "CAPTURE"), eq(paymentOperations.actorUserId, user.id), eq(paymentOperations.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.milestoneId !== milestoneId || existing.requestFingerprint !== fingerprint) throw new AppError("CONFLICT", "This idempotency key belongs to a different capture request.", 409);
      const [capture] = await tx.select().from(captures).where(eq(captures.operationId, existing.id)).limit(1);
      return { operation: existing, capture, isRetry: true };
    }
    const [active] = await tx.select().from(captures).where(and(eq(captures.milestoneId, milestoneId))).limit(1);
    if (active && ["REQUESTED", "IN_PROGRESS", "UNKNOWN", "PENDING", "COMPLETED"].includes(active.status)) throw new AppError("CONFLICT", "A capture request already exists. Resolve it before trying again.", 409);
    const operationId = randomUUID();
    const [created] = await tx.insert(paymentOperations).values({ id: operationId, operationType: "CAPTURE", milestoneId, actorUserId: user.id, idempotencyKey, requestFingerprint: fingerprint, requestParameters: { amount_cents: body.data.confirm_amount_cents, authorization_id: snapshot.order.authorizationId }, status: "IN_PROGRESS" }).returning();
    const [capture] = await tx.insert(captures).values({ operationId, milestoneId, paypalOrderRowId: snapshot.order.id, authorizationId: snapshot.order.authorizationId!, amountCents: body.data.confirm_amount_cents, finalCapture: true, releasedBy: user.id, status: "IN_PROGRESS" }).returning();
    await tx.update(milestones).set({ captureStatus: "IN_PROGRESS", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
    await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "CAPTURE_REQUESTED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, amountCents: body.data.confirm_amount_cents, currency: snapshot.milestone.currency, paypalRef: snapshot.order.authorizationId, data: { operation_id: operationId } });
    return { operation: created!, capture: capture!, isRetry: false };
  });
  if (operation.operation.status === "SUCCEEDED") return Response.json({ capture: operation.capture, status: operation.capture?.status });
  if (operation.operation.status === "FAILED") throw new AppError("CONFLICT", "This capture attempt failed. Review the authorization before creating a new request.", 409);
  try {
    const authorizationId = snapshot.order.authorizationId!;
    if (!operation.isRetry) {
      const authorization = await getAuthorization(authorizationId);
      if (authorization.status !== "CREATED") throw new PayPalError("PayPal authorization is no longer capturable.", 409, "AUTHORIZATION_NOT_CAPTURABLE");
      const providerAmount = authorization.amount;
      if (providerAmount && (providerAmount.currency_code !== snapshot.order.currency || Number(providerAmount.value) !== body.data.confirm_amount_cents / 100)) throw new PayPalError("Authorization amount does not match the signed milestone.", 409, "AUTHORIZATION_AMOUNT_MISMATCH");
    }
    const result = await captureAuthorization({ authorizationId, amountCents: body.data.confirm_amount_cents, currency: snapshot.order.currency, requestId: operation.operation.id, invoiceId: `milestone-${milestoneId}` });
    if (!result.id) throw new PayPalError("PayPal returned a capture without an ID.", 502, "MISSING_CAPTURE_ID", undefined, true);
    const completed = result.status === "COMPLETED";
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: completed ? "SUCCEEDED" : "PENDING", providerObjectId: result.id, attemptCount: operation.operation.attemptCount + 1, updatedAt: new Date() }).where(eq(paymentOperations.id, operation.operation.id));
      await tx.update(captures).set({ status: completed ? "COMPLETED" : "PENDING", paypalCaptureId: result.id, updatedAt: new Date() }).where(eq(captures.operationId, operation.operation.id));
      await tx.update(milestones).set({ captureStatus: completed ? "COMPLETED" : "PENDING", workStatus: completed ? "RELEASED" : "SUBMITTED", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: completed ? "CAPTURE_CONFIRMED" : "CAPTURE_PENDING", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, amountCents: body.data.confirm_amount_cents, currency: snapshot.milestone.currency, paypalRef: result.id, data: { operation_id: operation.operation.id, provider_status: result.status } });
    });
    return Response.json({ capture: { id: result.id, status: completed ? "COMPLETED" : "PENDING", amount_cents: body.data.confirm_amount_cents }, payout: null });
  } catch (error) {
    const uncertain = error instanceof PayPalError ? error.uncertain : true;
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: uncertain ? "UNKNOWN" : "FAILED", attemptCount: operation.operation.attemptCount + 1, lastErrorCode: error instanceof PayPalError ? error.issue : "NETWORK_ERROR", debugId: error instanceof PayPalError ? error.debugId : null, updatedAt: new Date() }).where(eq(paymentOperations.id, operation.operation.id));
      await tx.update(captures).set({ status: uncertain ? "UNKNOWN" : "FAILED", updatedAt: new Date() }).where(eq(captures.operationId, operation.operation.id));
      await tx.update(milestones).set({ captureStatus: uncertain ? "UNKNOWN" : "FAILED", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
    });
    throw error;
  }
}, { mutation: true, rateLimit: { key: (request) => `capture:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 8, windowMs: 60_000 } });
