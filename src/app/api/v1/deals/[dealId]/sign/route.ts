import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, termsSnapshots } from "@/server/db/schema";
import { AppError } from "@/server/errors";

const schema = z.object({ terms_version: z.number().int().positive() });

export const POST = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const dealId = (await context.params).dealId;
  if (!dealId) throw new AppError("VALIDATION_ERROR", "Agreement ID is required.", 400);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "A valid terms version is required.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const result = await db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("update").limit(1);
    if (!deal || (deal.clientId !== user.id && deal.freelancerId !== user.id)) throw new AppError("NOT_FOUND", "Agreement not found.", 404);
    if (!deal.freelancerId) throw new AppError("CONFLICT", "The freelancer must join before either person signs.", 409);
    if (deal.status !== "TERMS_PROPOSED" || parsed.data.terms_version !== deal.termsVersion) throw new AppError("CONFLICT", "These terms are no longer current or cannot be signed.", 409);
    const now = new Date();
    const clientSignature = deal.clientId === user.id ? now : deal.clientSignedAt;
    const freelancerSignature = deal.freelancerId === user.id ? now : deal.freelancerSignedAt;
    const fullySigned = Boolean(clientSignature && freelancerSignature);
    await tx.update(deals).set({
      clientSignedVersion: deal.clientId === user.id ? deal.termsVersion : deal.clientSignedVersion,
      freelancerSignedVersion: deal.freelancerId === user.id ? deal.termsVersion : deal.freelancerSignedVersion,
      clientSignedAt: clientSignature,
      freelancerSignedAt: freelancerSignature,
      status: fullySigned ? "ACTIVE" : deal.status,
      updatedAt: now,
    }).where(eq(deals.id, dealId));
    await tx.update(termsSnapshots).set({
      clientSignedAt: deal.clientId === user.id ? now : deal.clientSignedAt,
      freelancerSignedAt: deal.freelancerId === user.id ? now : deal.freelancerSignedAt,
    }).where(and(eq(termsSnapshots.dealId, dealId), eq(termsSnapshots.version, deal.termsVersion)));
    if (fullySigned) await tx.update(milestones).set({ workStatus: "NOT_STARTED", updatedAt: now }).where(eq(milestones.dealId, dealId));
    await tx.insert(auditEvents).values({ category: "DEAL", eventType: "TERMS_SIGNED", dealId, actorType: "USER", actorUserId: user.id, data: { terms_version: deal.termsVersion, both_signed: fullySigned } });
    return { status: fullySigned ? "ACTIVE" : "TERMS_PROPOSED", terms_version: deal.termsVersion, both_signed: fullySigned };
  });
  return Response.json(result);
}, { mutation: true, rateLimit: { key: (request) => `terms-sign:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 20, windowMs: 60_000 } });
