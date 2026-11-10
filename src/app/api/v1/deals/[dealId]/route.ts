import { and, desc, eq, isNull, or } from "drizzle-orm";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { deals, mandates, milestones, paypalOrders, submissions, users, verifications } from "@/server/db/schema";
import { AppError } from "@/server/errors";

export const GET = apiRouteWithContext(async (_request, _requestId, context) => {
  const user = await requireUser();
  const dealId = (await context.params).dealId;
  if (!dealId) throw new AppError("VALIDATION_ERROR", "Agreement ID is required.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const sessionScope = user.demoSessionId ? eq(deals.demoSessionId, user.demoSessionId) : isNull(deals.demoSessionId);
  const [deal] = await db.select({ deal: deals, clientName: users.displayName })
    .from(deals).innerJoin(users, eq(deals.clientId, users.id)).where(and(eq(deals.id, dealId), or(eq(deals.clientId, user.id), eq(deals.freelancerId, user.id)), sessionScope)).limit(1);
  if (!deal) throw new AppError("NOT_FOUND", "Agreement not found.", 404);
  const role = deal.deal.clientId === user.id ? "client" : "freelancer";
  const [freelancer] = deal.deal.freelancerId ? await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, deal.deal.freelancerId)).limit(1) : [];
  const [ownMandate] = await db.select().from(mandates).where(and(eq(mandates.dealId, dealId), eq(mandates.userId, user.id))).limit(1);
  const milestoneRows = await db.select().from(milestones).where(eq(milestones.dealId, dealId)).orderBy(milestones.idx);
  const details = await Promise.all(milestoneRows.map(async (milestone) => {
    const [submission] = await db.select().from(submissions).where(eq(submissions.milestoneId, milestone.id)).orderBy(desc(submissions.createdAt)).limit(1);
    const [verification] = submission ? await db.select().from(verifications).where(eq(verifications.submissionId, submission.id)).orderBy(desc(verifications.createdAt)).limit(1) : [];
    const [hold] = await db.select().from(paypalOrders).where(eq(paypalOrders.milestoneId, milestone.id)).orderBy(desc(paypalOrders.createdAt)).limit(1);
    const client = role === "client";
    const allowedActions = {
      fund: client && deal.deal.status === "ACTIVE" && milestone.authorizationStatus === "NONE" && ["NOT_STARTED", "REVISION_REQUESTED"].includes(milestone.workStatus) && ["NONE", "FAILED", "CANCELLED"].includes(milestone.captureStatus) && (!hold || !["REQUESTED", "IN_PROGRESS", "UNKNOWN", "CREATED", "AUTHORIZED"].includes(hold.status)),
      submit: !client && milestone.authorizationStatus === "AUTHORIZED" && hold?.status === "AUTHORIZED" && ["NOT_STARTED", "REVISION_REQUESTED"].includes(milestone.workStatus),
      verify: milestone.workStatus === "SUBMITTED",
      release: client && milestone.authorizationStatus === "AUTHORIZED" && hold?.status === "AUTHORIZED" && milestone.workStatus === "SUBMITTED" && ["NONE", "FAILED"].includes(milestone.captureStatus),
      cancel: client && ["NOT_STARTED", "REVISION_REQUESTED"].includes(milestone.workStatus) && ["NONE", "AUTHORIZED"].includes(milestone.authorizationStatus) && milestone.captureStatus === "NONE" && (!hold || !["REQUESTED", "IN_PROGRESS", "UNKNOWN"].includes(hold.status)),
      requestRevision: client && milestone.workStatus === "SUBMITTED" && milestone.captureStatus === "NONE",
    };
    return { ...milestone, allowedActions, latestSubmission: submission ?? null, verification: verification ?? null, hold: hold ?? null };
  }));
  return Response.json({ ...deal.deal, myRole: role, client: { id: deal.deal.clientId, displayName: deal.clientName, signed: deal.deal.clientSignedVersion === deal.deal.termsVersion }, freelancer: freelancer ? { ...freelancer, signed: deal.deal.freelancerSignedVersion === deal.deal.termsVersion } : null, myMandate: ownMandate ?? null, milestones: details, inviteUrl: `${new URL(_request.url).origin}/join/${deal.deal.inviteToken}` });
});
