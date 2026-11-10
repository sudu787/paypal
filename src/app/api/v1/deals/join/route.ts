import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, mandates, milestones, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";

const schema = z.object({
  invite_token: z.string().min(24).max(128),
  mandate: z.object({ min_total_cents: z.number().int().min(100).max(10_000_000), earliest_days: z.number().int().min(1).max(365), preferred_milestones: z.number().int().min(1).max(12).optional(), priorities: z.string().max(1000).default("") }),
  paypal_email: z.email().optional(),
});

export const POST = apiRoute(async (request) => {
  const user = await requireUser();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Check the invitation and your minimum terms.", 400, parsed.error.issues);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [deal] = await db.select().from(deals).where(eq(deals.inviteToken, parsed.data.invite_token)).limit(1);
  if (!deal || deal.status === "CANCELLED") throw new AppError("NOT_FOUND", "This invitation is unavailable.", 404);
  if (deal.clientId === user.id) throw new AppError("CONFLICT", "You cannot join your own agreement as the freelancer.", 409);
  if (deal.freelancerId && deal.freelancerId !== user.id) throw new AppError("CONFLICT", "This invitation has already been claimed.", 409);
  const proposedMilestones = await db.select().from(milestones).where(eq(milestones.dealId, deal.id));
  const proposedTotal = proposedMilestones.reduce((sum, item) => sum + item.amountCents, 0);
  if (parsed.data.mandate.min_total_cents > proposedTotal || Math.max(...proposedMilestones.map((item) => item.dueInDays), 0) < parsed.data.mandate.earliest_days) {
    throw new AppError("CONFLICT", "The proposed milestone amount or timing does not meet your stated minimum terms.", 409);
  }
  await db.transaction(async (tx) => {
    const [updatedDeal] = await tx.update(deals).set({ freelancerId: user.id, status: "TERMS_PROPOSED", updatedAt: new Date() })
      .where(and(eq(deals.id, deal.id), isNull(deals.freelancerId))).returning({ id: deals.id });
    if (!updatedDeal && deal.freelancerId !== user.id) throw new AppError("CONFLICT", "This invitation has already been claimed.", 409);
    if (!deal.freelancerId) {
      await tx.insert(mandates).values({ dealId: deal.id, userId: user.id, role: "freelancer", minTotalCents: parsed.data.mandate.min_total_cents, earliestDays: parsed.data.mandate.earliest_days, preferredMilestones: parsed.data.mandate.preferred_milestones, priorities: parsed.data.mandate.priorities });
      if (parsed.data.paypal_email) await tx.update(users).set({ paypalEmail: parsed.data.paypal_email }).where(eq(users.id, user.id));
      await tx.insert(auditEvents).values({ category: "DEAL", eventType: "FREELANCER_JOINED", dealId: deal.id, actorType: "USER", actorUserId: user.id });
    }
  });
  return Response.json({ deal_id: deal.id, status: "TERMS_PROPOSED", invite_joined: true });
}, { mutation: true, rateLimit: { key: (request) => `deal-join:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
