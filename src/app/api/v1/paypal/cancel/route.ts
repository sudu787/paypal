import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, paymentOperations, paypalOrders } from "@/server/db/schema";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const fundingId = url.searchParams.get("fa");
  if (!fundingId) return Response.redirect(new URL("/workspace?pay_error=invalid_return", env.APP_URL), 303);
  try {
    const user = await requireUser();
    const db = getDatabase();
    if (!db) return Response.redirect(new URL("/workspace?pay_error=database_unavailable", env.APP_URL), 303);
    const [funding] = await db.select({ providerOrder: paypalOrders, operation: paymentOperations, milestone: milestones, deal: deals })
      .from(paypalOrders).innerJoin(paymentOperations, eq(paypalOrders.operationId, paymentOperations.id))
      .innerJoin(milestones, eq(paypalOrders.milestoneId, milestones.id)).innerJoin(deals, eq(milestones.dealId, deals.id))
      .where(and(eq(paymentOperations.id, fundingId), eq(paypalOrders.createdBy, user.id))).limit(1);
    if (!funding || funding.deal.clientId !== user.id) return Response.redirect(new URL("/workspace?pay_error=invalid_return", env.APP_URL), 303);
    await db.transaction(async (tx) => {
      if (funding.providerOrder.status === "CREATED") {
        await tx.update(paypalOrders).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(paypalOrders.id, funding.providerOrder.id));
        await tx.update(paymentOperations).set({ status: "FAILED", lastErrorCode: "PAYER_CANCELLED", updatedAt: new Date() }).where(eq(paymentOperations.id, funding.operation.id));
        await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "ORDER_CANCELLED_BY_PAYER", dealId: funding.deal.id, milestoneId: funding.milestone.id, actorType: "USER", actorUserId: user.id, paypalRef: funding.providerOrder.paypalOrderId });
      }
    });
    return Response.redirect(new URL(`/workspace?deal=${encodeURIComponent(funding.deal.id)}&pay_cancelled=1`, env.APP_URL), 303);
  } catch {
    return Response.redirect(new URL("/workspace?pay_error=cancel_failed", env.APP_URL), 303);
  }
}
