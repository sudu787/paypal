import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, paymentOperations, paypalOrders } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { PayPalError, createAuthorizeOrder, getOrder } from "@/server/paypal/client";

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!milestoneId || !idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "A milestone ID and UUID Idempotency-Key are required.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [snapshot] = await db.select({ milestone: milestones, deal: deals }).from(milestones).innerJoin(deals, eq(milestones.dealId, deals.id)).where(eq(milestones.id, milestoneId)).limit(1);
  if (!snapshot || snapshot.deal.clientId !== user.id) throw new AppError("NOT_FOUND", "Milestone not found.", 404);
  if (snapshot.deal.status !== "ACTIVE") throw new AppError("CONFLICT", "Both people must sign the agreement before funding.", 409);
  const fingerprint = createHash("sha256").update(JSON.stringify({ milestone_id: milestoneId, amount_cents: snapshot.milestone.amountCents, currency: snapshot.milestone.currency })).digest("hex");
  const operation = await db.transaction(async (tx) => {
    const [milestone] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update").limit(1);
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.operationType, "CREATE_ORDER"), eq(paymentOperations.actorUserId, user.id), eq(paymentOperations.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.milestoneId !== milestoneId || existing.requestFingerprint !== fingerprint) throw new AppError("CONFLICT", "This idempotency key was already used for a different payment request.", 409);
      const [order] = await tx.select().from(paypalOrders).where(eq(paypalOrders.operationId, existing.id)).limit(1);
      return { operation: existing, order };
    }
    if (!milestone || milestone.authorizationStatus !== "NONE") throw new AppError("CONFLICT", "This milestone is not awaiting its first authorization.", 409);
    const [existingHold] = await tx.select().from(paypalOrders).where(eq(paypalOrders.milestoneId, milestoneId)).orderBy(desc(paypalOrders.createdAt)).limit(1);
    if (existingHold && ["REQUESTED", "IN_PROGRESS", "UNKNOWN", "CREATED", "AUTHORIZED"].includes(existingHold.status)) throw new AppError("CONFLICT", "A funding request or authorization already exists for this milestone.", 409);
    const operationId = randomUUID();
    const [createdOperation] = await tx.insert(paymentOperations).values({ id: operationId, operationType: "CREATE_ORDER", milestoneId, actorUserId: user.id, idempotencyKey, requestFingerprint: fingerprint, requestParameters: { amount_cents: milestone.amountCents, currency: milestone.currency }, status: "IN_PROGRESS" }).returning();
    const [createdOrder] = await tx.insert(paypalOrders).values({ operationId, milestoneId, createdBy: user.id, amountCents: milestone.amountCents, currency: milestone.currency, status: "IN_PROGRESS" }).returning();
    await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "ORDER_CREATE_REQUESTED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, amountCents: milestone.amountCents, currency: milestone.currency, data: { operation_id: operationId } });
    return { operation: createdOperation!, order: createdOrder! };
  });

  if (operation.operation.status === "FAILED") throw new AppError("CONFLICT", "This funding attempt failed. Start a new attempt with a new idempotency key.", 409);
  if (operation.order?.paypalOrderId && operation.order.status === "CREATED") {
    const providerOrder = await getOrder(operation.order.paypalOrderId);
    const approval = providerOrder.links.find((link) => link.rel === "payer-action" || link.rel === "approve");
    if (!approval) throw new PayPalError("PayPal order has no approval link.", 502, "MISSING_APPROVAL_LINK", undefined, true);
    return Response.json({ funding_attempt_id: operation.operation.id, approve_url: approval.href, status: operation.order.status });
  }

  try {
    const result = await createAuthorizeOrder({
      milestoneId,
      amountCents: operation.order?.amountCents ?? snapshot.milestone.amountCents,
      currency: operation.order?.currency ?? snapshot.milestone.currency,
      requestId: operation.operation.id,
      returnUrl: `${new URL(request.url).origin}/api/v1/paypal/return?fa=${operation.operation.id}`,
      cancelUrl: `${new URL(request.url).origin}/api/v1/paypal/cancel?fa=${operation.operation.id}`,
    });
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: "SUCCEEDED", providerObjectId: result.id, attemptCount: operation.operation.attemptCount + 1, updatedAt: new Date() }).where(eq(paymentOperations.id, operation.operation.id));
      await tx.update(paypalOrders).set({ paypalOrderId: result.id, status: "CREATED", updatedAt: new Date() }).where(eq(paypalOrders.operationId, operation.operation.id));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "ORDER_CREATED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, amountCents: snapshot.milestone.amountCents, currency: snapshot.milestone.currency, paypalRef: result.id, data: { operation_id: operation.operation.id } });
    });
    return Response.json({ funding_attempt_id: operation.operation.id, approve_url: result.approveUrl, status: result.status }, { status: 201 });
  } catch (error) {
    const uncertain = error instanceof PayPalError ? error.uncertain : true;
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: uncertain ? "UNKNOWN" : "FAILED", attemptCount: operation.operation.attemptCount + 1, lastErrorCode: error instanceof PayPalError ? error.issue : "NETWORK_ERROR", debugId: error instanceof PayPalError ? error.debugId : null, updatedAt: new Date() }).where(eq(paymentOperations.id, operation.operation.id));
      await tx.update(paypalOrders).set({ status: uncertain ? "UNKNOWN" : "FAILED", failureReason: error instanceof Error ? error.message.slice(0, 500) : "Provider error", updatedAt: new Date() }).where(eq(paypalOrders.operationId, operation.operation.id));
    });
    throw error;
  }
}, { mutation: true, rateLimit: { key: (request) => `fund:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 8, windowMs: 60_000 } });
