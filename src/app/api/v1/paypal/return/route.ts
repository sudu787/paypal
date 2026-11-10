import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, durableJobs, milestones, paymentOperations, paypalOrders } from "@/server/db/schema";
import { PayPalError, authorizeOrder, getOrder } from "@/server/paypal/client";
import { logger } from "@/server/logger";

function back(request: NextRequest, dealId: string, result: string) {
  const url = new URL(`/workspace?deal=${encodeURIComponent(dealId)}&${result}`, request.url);
  return Response.redirect(url, 303);
}

export async function GET(request: NextRequest) {
  let dealId = "";
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const fundingId = url.searchParams.get("fa");
    const paypalOrderId = url.searchParams.get("token");
    if (!fundingId || !paypalOrderId) return back(request, "", "pay_error=invalid_return");
    const db = getDatabase();
    if (!db) return back(request, "", "pay_error=database_unavailable");
    const [funding] = await db.select({ providerOrder: paypalOrders, operation: paymentOperations, milestone: milestones, deal: deals })
      .from(paypalOrders).innerJoin(paymentOperations, eq(paypalOrders.operationId, paymentOperations.id))
      .innerJoin(milestones, eq(paypalOrders.milestoneId, milestones.id)).innerJoin(deals, eq(milestones.dealId, deals.id))
      .where(eq(paymentOperations.id, fundingId)).limit(1);
    if (!funding || funding.providerOrder.createdBy !== user.id || funding.deal.clientId !== user.id || funding.providerOrder.paypalOrderId !== paypalOrderId || !["CREATED", "AUTHORIZED"].includes(funding.providerOrder.status)) return back(request, "", "pay_error=invalid_return");
    dealId = funding.deal.id;
    if (funding.providerOrder.status === "AUTHORIZED") return back(request, dealId, "authorized=1");

    const providerOrder = await getOrder(paypalOrderId);
    if (providerOrder.status !== "APPROVED" || providerOrder.purchase_units?.[0]?.reference_id !== funding.milestone.id) throw new PayPalError("PayPal approval did not match this milestone.", 409, "APPROVAL_MISMATCH");
    const orderAmount = providerOrder.purchase_units?.[0]?.amount;
    if (!orderAmount || orderAmount.currency_code !== funding.providerOrder.currency || Number(orderAmount.value) !== funding.providerOrder.amountCents / 100) throw new PayPalError("Approved amount does not match the signed milestone.", 409, "AMOUNT_MISMATCH");

    const authorizeKey = `authorize:${fundingId}`;
    const authorizeFingerprint = `${paypalOrderId}:${funding.milestone.id}:${funding.providerOrder.amountCents}:${funding.providerOrder.currency}`;
    const authorizeOperation = await db.transaction(async (tx) => {
      await tx.select().from(paypalOrders).where(eq(paypalOrders.id, funding.providerOrder.id)).for("update").limit(1);
      const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.operationType, "AUTHORIZE"), eq(paymentOperations.actorUserId, user.id), eq(paymentOperations.idempotencyKey, authorizeKey))).limit(1);
      if (existing) {
        if (existing.requestFingerprint !== authorizeFingerprint || existing.milestoneId !== funding.milestone.id) throw new PayPalError("Authorization retry did not match its original request.", 409, "IDEMPOTENCY_CONFLICT");
        return existing;
      }
      const [created] = await tx.insert(paymentOperations).values({ id: randomUUID(), operationType: "AUTHORIZE", milestoneId: funding.milestone.id, actorUserId: user.id, idempotencyKey: authorizeKey, requestFingerprint: authorizeFingerprint, requestParameters: { paypal_order_id: paypalOrderId, amount_cents: funding.providerOrder.amountCents, currency: funding.providerOrder.currency }, status: "IN_PROGRESS" }).returning();
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_REQUESTED", dealId, milestoneId: funding.milestone.id, actorType: "USER", actorUserId: user.id, amountCents: funding.providerOrder.amountCents, currency: funding.providerOrder.currency, paypalRef: paypalOrderId, data: { operation_id: created!.id } });
      return created!;
    });
    if (authorizeOperation.status === "SUCCEEDED") return back(request, dealId, "authorized=1");
    try {
      const authorizationResponse = await authorizeOrder(paypalOrderId, authorizeOperation.id);
      let authorization = authorizationResponse.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
      if (!authorization?.id) {
        const refreshed = await getOrder(paypalOrderId);
        authorization = refreshed.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
      }
      if (!authorization?.id) throw new PayPalError("PayPal did not return an authorization reference.", 502, "MISSING_AUTHORIZATION", undefined, true);

      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: "SUCCEEDED", providerObjectId: authorization!.id, attemptCount: authorizeOperation.attemptCount + 1, updatedAt: new Date() }).where(eq(paymentOperations.id, authorizeOperation.id));
        await tx.update(paypalOrders).set({ status: "AUTHORIZED", authorizationId: authorization!.id, authorizationStatus: authorization!.status, updatedAt: new Date() }).where(eq(paypalOrders.id, funding.providerOrder.id));
        await tx.update(milestones).set({ authorizationStatus: "AUTHORIZED", updatedAt: new Date() }).where(eq(milestones.id, funding.milestone.id));
        await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_CONFIRMED", dealId, milestoneId: funding.milestone.id, actorType: "USER", actorUserId: user.id, amountCents: funding.providerOrder.amountCents, currency: funding.providerOrder.currency, paypalRef: authorization!.id, data: { operation_id: authorizeOperation.id, paypal_order_id: paypalOrderId, authorization_status: authorization!.status } });
      });
      return back(request, dealId, "authorized=1");
    } catch (error) {
      const uncertain = error instanceof PayPalError ? error.uncertain : true;
      await db.transaction(async (tx) => {
        await tx.update(paymentOperations).set({ status: uncertain ? "UNKNOWN" : "FAILED", attemptCount: authorizeOperation.attemptCount + 1, lastErrorCode: error instanceof PayPalError ? error.issue : "NETWORK_ERROR", debugId: error instanceof PayPalError ? error.debugId : null, updatedAt: new Date() }).where(eq(paymentOperations.id, authorizeOperation.id));
        if (uncertain) {
          await tx.update(paypalOrders).set({ status: "UNKNOWN", updatedAt: new Date() }).where(eq(paypalOrders.id, funding.providerOrder.id));
          await tx.update(milestones).set({ authorizationStatus: "UNKNOWN", updatedAt: new Date() }).where(eq(milestones.id, funding.milestone.id));
          await tx.insert(durableJobs).values({ kind: "PAYMENT_RECOVERY", resourceId: authorizeOperation.id, status: "QUEUED" }).onConflictDoNothing();
        }
      });
      throw error;
    }
  } catch (error) {
    logger.error({ error, event: "paypal_return_authorization_failed" });
    return back(request, dealId, "pay_error=authorization_failed");
  }
}
