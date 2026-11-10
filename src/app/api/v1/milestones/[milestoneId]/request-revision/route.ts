import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, submissions } from "@/server/db/schema";
import { AppError } from "@/server/errors";

const schema = z.object({ note: z.string().trim().min(5).max(2000) });

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Add a clear note about the requested change.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  await db.transaction(async (tx) => {
    const [snapshot] = await tx.select({ milestone: milestones, deal: deals }).from(milestones).innerJoin(deals, eq(milestones.dealId, deals.id)).where(eq(milestones.id, milestoneId)).for("update").limit(1);
    if (!snapshot || snapshot.deal.clientId !== user.id) throw new AppError("NOT_FOUND", "Milestone not found for this client.", 404);
    if (snapshot.milestone.workStatus !== "SUBMITTED" || snapshot.milestone.captureStatus !== "NONE") throw new AppError("CONFLICT", "A revision can only be requested before capture.", 409);
    if (snapshot.milestone.revisionsUsed >= snapshot.deal.revisionRounds) throw new AppError("CONFLICT", "No revision rounds remain for this milestone.", 409);
    const [submission] = await tx.select({ id: submissions.id }).from(submissions).where(eq(submissions.milestoneId, milestoneId)).orderBy(desc(submissions.createdAt)).limit(1);
    if (!submission) throw new AppError("CONFLICT", "There is no submission to revise.", 409);
    await tx.update(milestones).set({ workStatus: "REVISION_REQUESTED", revisionsUsed: snapshot.milestone.revisionsUsed + 1, updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
    await tx.insert(auditEvents).values({ category: "WORK", eventType: "REVISION_REQUESTED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, note: parsed.data.note });
  });
  return Response.json({ status: "REVISION_REQUESTED" });
}, { mutation: true, rateLimit: { key: (request) => `revision:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
