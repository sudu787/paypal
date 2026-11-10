import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, submissions } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { verifySubmission } from "@/server/ai/verifier";

const schema = z.object({ evidence_text: z.string().trim().min(10).max(20_000), evidence_url: z.url().max(2048).refine((value) => new URL(value).protocol === "https:", "Evidence links must use HTTPS.").optional() });

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide evidence text and an optional HTTPS link.", 400, parsed.error.issues);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const result = await db.transaction(async (tx) => {
    const [snapshot] = await tx.select({ milestone: milestones, deal: deals }).from(milestones).innerJoin(deals, eq(milestones.dealId, deals.id)).where(eq(milestones.id, milestoneId)).for("update").limit(1);
    if (!snapshot || snapshot.deal.freelancerId !== user.id) throw new AppError("NOT_FOUND", "Milestone not found for this freelancer.", 404);
    if (snapshot.deal.status !== "ACTIVE" || snapshot.milestone.authorizationStatus !== "AUTHORIZED") throw new AppError("CONFLICT", "An active milestone authorization is required before submitting work.", 409);
    if (!["NOT_STARTED", "REVISION_REQUESTED"].includes(snapshot.milestone.workStatus)) throw new AppError("CONFLICT", "This milestone is not accepting a submission right now.", 409);
    if (snapshot.milestone.workStatus === "REVISION_REQUESTED" && snapshot.milestone.revisionsUsed > snapshot.deal.revisionRounds) throw new AppError("CONFLICT", "The allowed revision round has been used.", 409);
    const [submission] = await tx.insert(submissions).values({ milestoneId, submittedBy: user.id, evidenceText: parsed.data.evidence_text, evidenceUrl: parsed.data.evidence_url ?? null }).returning();
    await tx.update(milestones).set({ workStatus: "SUBMITTED", updatedAt: new Date() }).where(eq(milestones.id, milestoneId));
    await tx.insert(auditEvents).values({ category: "WORK", eventType: "WORK_SUBMITTED", dealId: snapshot.deal.id, milestoneId, actorType: "USER", actorUserId: user.id, note: submission!.evidenceUrl ?? undefined, data: { submission_id: submission!.id } });
    return submission!;
  });
  let verification = null;
  let verificationError: string | null = null;
  try { verification = await verifySubmission(milestoneId, user.id); }
  catch (error) { verificationError = error instanceof Error ? error.message : "AI review could not be completed."; }
  return Response.json({ submission: result, verification: verification?.verification ?? null, verification_mode: verification?.mode ?? null, verification_error: verificationError }, { status: 201 });
}, { mutation: true, rateLimit: { key: (request) => `submission:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
