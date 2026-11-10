import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, durableJobs, milestones, paymentOperations, paypalOrders, submissions } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { PayPalError, voidAuthorization } from "@/server/paypal/client";

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "A UUID Idempotency-Key is required.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const snapshot = await db.transaction(async (tx) => {
    const [base] = await tx.select({ milestone: milestones, deal: deals }).from(milestones).innerJoin(deals, eq(milestones.dealId, deals.id)).where(eq(milestones.id, milestoneId)).for("update").limit(1);
    if (!base || base.deal.clientId !== user.id) throw new AppError("NOT_FOUND", "Milestone not found for this client.", 404);
    const [latestOrder] = await tx.select().from(paypalOrders).where(eq(paypalOrders.milestoneId, milestoneId)).orderBy(desc(paypalOrders.createdAt)).limit(1);
    const row = { ...base, order: latestOrder };
    if (!["NOT_STARTED", "REVISION_REQUESTED"].includes(row.milestone.workStatus) || row.milestone.captureStatus !== "NONE") throw new AppError("CONFLICT", "This milestone can no longer be cancelled.", 409);
    const [submission] = await tx.select({ id: submissions.id }).from(submissions).where(eq(submissions.milestoneId, milestoneId)).limit(1);
    if (submission) throw new AppError("CONFLICT", "A milestone with submitted work cannot be cancelled here.", 409);
    if (row.milestone.authorizationStatus === "NONE") {
      if (row.order && ["REQUESTED", "IN_PROGRESS", "UNKNOWN"].includes(row.order.status)) throw new AppError("CONFLICT", "The PayPal order outcome is still being resolved. Try again after it is reconciled.", 409);
      if (row.order?.status === "CREATED") {
        await tx.update(paypalOrders).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(paypalOrders.id, row.order.id));
        await tx.update(paymentOperations).set({ status: "FAILED", lastErrorCode: "ORDER_CANCELLED", updatedAt: new Date() }).where(eq(paymentOperations.id, row.order.operationId));
      }
      await tx.update(milestones).set({ workStatus: "CANCELLED", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
      const [remaining] = await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.dealId, row.deal.id), ne(milestones.workStatus, "CANCELLED"))).limit(1);
      if (!remaining) await tx.update(deals).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(deals.id, row.deal.id));
      await tx.insert(auditEvents).values({ category: row.order?.status === "CREATED" ? "PAYMENT" : "WORK", eventType: row.order?.status === "CREATED" ? "ORDER_CANCELLED" : "MILESTONE_CANCELLED", dealId: row.deal.id, milestoneId, actorType: "USER", actorUserId: user.id });
      return { deal: row.deal, milestone: row.milestone, order: row.order, operation: null, localOnly: true };
    }
    if (!row.order?.authorizationId) throw new AppError("CONFLICT", "Payment authorization details are unavailable.", 409);
    const key = idempotencyKey;
    const fingerprint = `${row.order.authorizationId}:${milestoneId}`;
    const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.operationType, "VOID"), eq(paymentOperations.actorUserId, user.id), eq(paymentOperations.idempotencyKey, key))).limit(1);
    if (existing) {
      if (existing.milestoneId !== milestoneId || existing.requestFingerprint !== fingerprint || existing.requestParameters.authorization_id !== row.order.authorizationId) throw new AppError("CONFLICT", "The void retry does not match this authorization.", 409);
      return { deal: row.deal, milestone: row.milestone, order: row.order, operation: existing, localOnly: false };
    }
    if (row.milestone.authorizationStatus !== "AUTHORIZED") throw new AppError("CONFLICT", "Authorization is not in a state that can be voided safely.", 409);
    const [operation] = await tx.insert(paymentOperations).values({ id: randomUUID(), operationType: "VOID", milestoneId, actorUserId: user.id, idempotencyKey: key, requestFingerprint: fingerprint, requestParameters: { authorization_id: row.order.authorizationId }, status: "IN_PROGRESS" }).returning();
    await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_VOID_REQUESTED", dealId: row.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, paypalRef: row.order.authorizationId, data: { operation_id: operation!.id } });
    return { deal: row.deal, milestone: row.milestone, order: row.order, operation: operation!, localOnly: false };
  });
  if (snapshot.localOnly) return Response.json({ status: "CANCELLED", authorization: "NONE" });
  if (!snapshot.operation || !snapshot.order?.authorizationId) throw new AppError("INTERNAL", "Void operation is missing its authorization.");
  if (snapshot.operation.status === "SUCCEEDED") return Response.json({ status: "CANCELLED", authorization: "VOIDED" });
  if (snapshot.operation.status === "FAILED") throw new AppError("CONFLICT", "This void attempt failed. Reconcile the authorization before retrying.", 409);
  try {
    await voidAuthorization(snapshot.order.authorizationId, snapshot.operation.id);
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: "SUCCEEDED", providerObjectId: snapshot.order!.authorizationId, attemptCount: snapshot.operation!.attemptCount + 1, updatedAt: new Date() }).where(eq(paymentOperations.id, snapshot.operation!.id));
      await tx.update(paypalOrders).set({ status: "VOIDED", authorizationStatus: "VOIDED", updatedAt: new Date() }).where(eq(paypalOrders.id, snapshot.order!.id));
      await tx.update(milestones).set({ authorizationStatus: "VOIDED", workStatus: "CANCELLED", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
      const [remaining] = await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.dealId, snapshot.deal.id), ne(milestones.workStatus, "CANCELLED"))).limit(1);
      if (!remaining) await tx.update(deals).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(deals.id, snapshot.deal.id));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_VOIDED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, paypalRef: snapshot.order!.authorizationId, data: { operation_id: snapshot.operation!.id } });
    });
    return Response.json({ status: "CANCELLED", authorization: "VOIDED" });
  } catch (error) {
    const uncertain = error instanceof PayPalError ? error.uncertain : true;
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: uncertain ? "UNKNOWN" : "FAILED", attemptCount: snapshot.operation!.attemptCount + 1, lastErrorCode: error instanceof PayPalError ? error.issue : "NETWORK_ERROR", debugId: error instanceof PayPalError ? error.debugId : null, updatedAt: new Date() }).where(eq(paymentOperations.id, snapshot.operation!.id));
      if (uncertain) {
        await tx.update(milestones).set({ authorizationStatus: "UNKNOWN", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
        await tx.insert(durableJobs).values({ kind: "PAYMENT_RECOVERY", resourceId: snapshot.operation!.id, status: "QUEUED" }).onConflictDoNothing();
      }
    });
    throw error;
  }
}, { mutation: true, rateLimit: { key: (request) => `cancel:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 8, windowMs: 60_000 } });
