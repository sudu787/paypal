import { and, desc, eq, or } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { agentRuns, auditEvents, deals, mandates, milestones, negotiationTurns, submissions, termsSnapshots, users, verifications } from "@/server/db/schema";
import { AppError } from "@/server/errors";

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  brief: z.string().trim().min(20).max(5000),
  currency: z.string().length(3).default("USD").transform((value) => value.toUpperCase()),
  mandate: z.object({ max_total_cents: z.number().int().min(100).max(10_000_000), deadline_days: z.number().int().min(1).max(365), priorities: z.string().max(1000).default("") }),
  milestones: z.array(z.object({ title: z.string().trim().min(2).max(120), description: z.string().trim().max(2000).default(""), acceptance_criteria: z.array(z.string().trim().min(3).max(500)).min(1).max(12), amount_cents: z.number().int().min(100).max(10_000_000), due_in_days: z.number().int().min(1).max(365) })).min(1).max(12),
});

export const GET = apiRoute(async (request) => {
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const inviteToken = new URL(request.url).searchParams.get("invite");
  if (inviteToken) {
    const [deal] = await db.select({ id: deals.id, title: deals.title, brief: deals.brief, status: deals.status, clientName: users.displayName })
      .from(deals).innerJoin(users, eq(deals.clientId, users.id)).where(eq(deals.inviteToken, inviteToken)).limit(1);
    if (!deal || deal.status === "CANCELLED") throw new AppError("NOT_FOUND", "This invitation is unavailable.", 404);
    return Response.json({ invite: deal });
  }
  const user = await requireUser();
  const rows = await db.select().from(deals).where(or(eq(deals.clientId, user.id), eq(deals.freelancerId, user.id))).orderBy(deals.createdAt);
  const result = await Promise.all(rows.map(async (deal) => {
    const [latestTurn] = await db.select({ runId: negotiationTurns.runId }).from(negotiationTurns).where(eq(negotiationTurns.dealId, deal.id)).orderBy(desc(negotiationTurns.runNumber), desc(negotiationTurns.seq)).limit(1);
    const [latestAgentRun] = await db.select({ mode: agentRuns.mode }).from(agentRuns).where(and(eq(agentRuns.dealId, deal.id), eq(agentRuns.kind, "NEGOTIATION"))).orderBy(desc(agentRuns.createdAt)).limit(1);
    const milestoneRows = await db.select().from(milestones).where(eq(milestones.dealId, deal.id)).orderBy(milestones.idx);
    const milestonesWithEvidence = await Promise.all(milestoneRows.map(async (milestone) => {
      const [submission] = await db.select().from(submissions).where(eq(submissions.milestoneId, milestone.id)).orderBy(desc(submissions.createdAt)).limit(1);
      const [verification] = submission ? await db.select().from(verifications).where(eq(verifications.submissionId, submission.id)).orderBy(desc(verifications.createdAt)).limit(1) : [];
      return { ...milestone, latestSubmission: submission ?? null, verification: verification ?? null };
    }));
    return {
      ...deal,
      milestones: milestonesWithEvidence,
      negotiationTurns: latestTurn ? await db.select().from(negotiationTurns).where(eq(negotiationTurns.runId, latestTurn.runId)).orderBy(negotiationTurns.seq) : [],
      aiMode: latestAgentRun?.mode ?? null,
    };
  }));
  return Response.json({ deals: result });
});

export const POST = apiRoute(async (request) => {
  const user = await requireUser();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Check the agreement details, budget, and milestone criteria.", 400, parsed.error.issues);
  const input = parsed.data;
  const total = input.milestones.reduce((sum, milestone) => sum + milestone.amount_cents, 0);
  if (total > input.mandate.max_total_cents) throw new AppError("VALIDATION_ERROR", "Milestone total exceeds your maximum budget.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const inviteToken = randomBytes(24).toString("base64url");
  const result = await db.transaction(async (tx) => {
    const [deal] = await tx.insert(deals).values({ title: input.title, brief: input.brief, clientId: user.id, inviteToken, status: "TERMS_PROPOSED", currency: input.currency, termsVersion: 1 }).returning();
    await tx.insert(mandates).values({ dealId: deal!.id, userId: user.id, role: "client", maxTotalCents: input.mandate.max_total_cents, deadlineDays: input.mandate.deadline_days, priorities: input.mandate.priorities });
    const milestoneRows = await tx.insert(milestones).values(input.milestones.map((item, index) => ({
      dealId: deal!.id, idx: index + 1, title: item.title, description: item.description,
      acceptanceCriteria: item.acceptance_criteria.map((text) => ({ criterion_id: randomBytes(8).toString("hex"), text })),
      amountCents: item.amount_cents, currency: input.currency, dueInDays: item.due_in_days,
    }))).returning();
    const canonical = { title: input.title, brief: input.brief, currency: input.currency, milestones: milestoneRows.map((item) => ({ id: item.id, idx: item.idx, title: item.title, description: item.description, acceptance_criteria: item.acceptanceCriteria, amount_cents: item.amountCents, due_in_days: item.dueInDays })) };
    await tx.insert(termsSnapshots).values({ dealId: deal!.id, version: 1, canonicalTerms: canonical, fingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") });
    await tx.insert(auditEvents).values({ category: "DEAL", eventType: "DEAL_CREATED", dealId: deal!.id, actorType: "USER", actorUserId: user.id, data: { terms_version: 1, milestone_count: milestoneRows.length } });
    return { deal: deal!, milestones: milestoneRows };
  });
  return Response.json({ ...result, invite_url: `${new URL(request.url).origin}/join/${inviteToken}` }, { status: 201 });
}, { mutation: true, rateLimit: { key: (request) => `deal-create:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
