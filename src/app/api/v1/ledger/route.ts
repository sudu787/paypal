import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { auditEvents, deals, milestones, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";

export const GET = apiRoute(async (request) => {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;
  const dealId = params.get("deal_id");
  const category = params.get("category");
  if (dealId && !z.uuid().safeParse(dealId).success) throw new AppError("VALIDATION_ERROR", "deal_id must be a UUID.", 400);
  if (category && (category.length > 50 || !/^[A-Z_]+$/i.test(category))) throw new AppError("VALIDATION_ERROR", "category is invalid.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const conditions = [];
  if (dealId) conditions.push(eq(auditEvents.dealId, dealId));
  if (category) conditions.push(eq(auditEvents.category, category.toUpperCase()));
  if (user.role !== "admin") {
    const partyDeals = await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, user.id)).union(
      db.select({ id: deals.id }).from(deals).where(eq(deals.freelancerId, user.id)),
    );
    const ids = partyDeals.map((row) => row.id);
    if (dealId && !ids.includes(dealId)) throw new AppError("NOT_FOUND", "Ledger not found.", 404);
    if (!ids.length) return Response.json({ rows: [] });
    conditions.push(inArray(auditEvents.dealId, ids));
  }
  const rows = await db.select({ event: auditEvents, dealTitle: deals.title, milestoneTitle: milestones.title, actorName: users.displayName })
    .from(auditEvents).leftJoin(deals, eq(auditEvents.dealId, deals.id)).leftJoin(milestones, eq(auditEvents.milestoneId, milestones.id)).leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(auditEvents.createdAt)).limit(1000);
  return Response.json({ rows });
});
