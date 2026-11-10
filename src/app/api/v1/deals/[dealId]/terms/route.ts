import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, mandates, milestones, termsSnapshots } from "@/server/db/schema";
import { validateTermSheet, type Mandate } from "@/server/ai/guards";
import type { TermSheet } from "@/server/ai/schemas";
import { isTermsEditable, preserveCriterionIds } from "@/server/deals/terms";
import { AppError } from "@/server/errors";

const schema = z.object({
  terms_version: z.number().int().positive(),
  revision_rounds: z.number().int().min(0).max(3).optional(),
  notes: z.string().max(1000).default(""),
  milestones: z.array(z.object({
    title: z.string().trim().min(2).max(120),
    description: z.string().max(2000),
    acceptance_criteria: z.array(z.string().trim().min(3).max(200)).min(1).max(6),
    amount_cents: z.number().int().min(100).max(10_000_000),
    due_in_days: z.number().int().min(1).max(180),
  })).min(1).max(5),
});

function asMandate(row: typeof mandates.$inferSelect): Mandate {
  return {
    role: row.role as Mandate["role"],
    maxTotalCents: row.maxTotalCents,
    deadlineDays: row.deadlineDays,
    minTotalCents: row.minTotalCents,
    earliestDays: row.earliestDays,
  };
}

export const PATCH = apiRouteWithContext(async (request, _requestId, context) => {
  const user = await requireUser();
  const dealId = (await context.params).dealId;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Check the agreement title, milestone details, and acceptance criteria.", 400, parsed.error.issues);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);

  const saved = await db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for("update").limit(1);
    if (!deal || (deal.clientId !== user.id && deal.freelancerId !== user.id)) throw new AppError("NOT_FOUND", "Agreement not found.", 404);
    if (!deal.freelancerId && deal.clientId !== user.id) throw new AppError("CONFLICT", "The client must create the invitation before terms can be edited.", 409);
    if (deal.termsVersion !== parsed.data.terms_version) throw new AppError("CONFLICT", "These terms are no longer editable. Reload the current version.", 409);
    const currentRows = await tx.select().from(milestones).where(eq(milestones.dealId, dealId)).orderBy(milestones.idx).for("update");
    if (currentRows.length !== parsed.data.milestones.length) throw new AppError("VALIDATION_ERROR", "This editor keeps the existing milestone count. Create a new agreement to change the count.", 400);
    if (!isTermsEditable(deal.status, currentRows)) throw new AppError("CONFLICT", "Terms cannot be changed after work or payment has started.", 409);

    const mandateRows = await tx.select().from(mandates).where(eq(mandates.dealId, dealId));
    const clientMandate = mandateRows.find((row) => row.role === "client");
    const freelancerMandate = mandateRows.find((row) => row.role === "freelancer");
    if (!clientMandate) throw new AppError("CONFIGURATION_ERROR", "The client mandate is missing.", 500);
    const termSheet: TermSheet = {
      milestones: parsed.data.milestones,
      total_cents: parsed.data.milestones.reduce((sum, item) => sum + item.amount_cents, 0),
      revision_rounds: parsed.data.revision_rounds ?? deal.revisionRounds,
      notes: parsed.data.notes,
    };
    const clientError = validateTermSheet(termSheet, asMandate(clientMandate));
    if (clientError) throw new AppError("VALIDATION_ERROR", clientError, 400);
    if (freelancerMandate) {
      const freelancerError = validateTermSheet(termSheet, asMandate(freelancerMandate));
      if (freelancerError) throw new AppError("VALIDATION_ERROR", freelancerError, 400);
    }

    const nextVersion = deal.termsVersion + 1;
    const updatedRows = [];
    for (const [index, item] of parsed.data.milestones.entries()) {
      const current = currentRows[index]!;
      const criteria = preserveCriterionIds(current.acceptanceCriteria, item.acceptance_criteria);
      const [updated] = await tx.update(milestones).set({
        title: item.title,
        description: item.description,
        acceptanceCriteria: criteria,
        amountCents: item.amount_cents,
        dueInDays: item.due_in_days,
        updatedAt: new Date(),
      }).where(and(eq(milestones.id, current.id), eq(milestones.dealId, dealId))).returning();
      if (updated) updatedRows.push(updated);
    }

    const canonicalTerms = {
      title: deal.title,
      brief: deal.brief,
      currency: deal.currency,
      milestones: updatedRows.map((row) => ({ id: row.id, idx: row.idx, title: row.title, description: row.description, acceptance_criteria: row.acceptanceCriteria, amount_cents: row.amountCents, due_in_days: row.dueInDays })),
      notes: termSheet.notes,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(canonicalTerms)).digest("hex");
    await tx.insert(termsSnapshots).values({ dealId, version: nextVersion, canonicalTerms, fingerprint });
    await tx.update(deals).set({
      termsVersion: nextVersion,
      revisionRounds: termSheet.revision_rounds,
      status: "TERMS_PROPOSED",
      clientSignedVersion: null,
      freelancerSignedVersion: null,
      clientSignedAt: null,
      freelancerSignedAt: null,
      updatedAt: new Date(),
    }).where(eq(deals.id, dealId));
    await tx.insert(auditEvents).values({ category: "DEAL", eventType: "TERMS_VERSION_EDITED", dealId, actorType: "USER", actorUserId: user.id, data: { terms_version: nextVersion, fingerprint } });
    return { terms_version: nextVersion, milestones: updatedRows };
  });
  return Response.json(saved);
}, { mutation: true, rateLimit: { key: (request) => `terms-edit:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 20, windowMs: 60_000 } });
