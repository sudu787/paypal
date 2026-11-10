import { createHash, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { deals, mandates, milestones, termsSnapshots, users } from "@/server/db/schema";

type Database = NonNullable<ReturnType<typeof getDatabase>>;

async function ensureDemoUser(db: Database, email: string, displayName: string) {
  const [existing] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
    .from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing;

  try {
    const [created] = await db.insert(users).values({
      email,
      displayName,
      role: "user",
      passwordHash: await hash(randomBytes(48).toString("hex"), 4),
    }).returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });
    if (created) return created;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "23505")) throw error;
  }

  const [raced] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
    .from(users).where(eq(users.email, email)).limit(1);
  if (!raced) throw new Error("Demo account could not be created.");
  return raced;
}

export async function ensureDemoSession(sessionId: string) {
  const db = getDatabase();
  if (!db) throw new Error("Database is not configured.");
  const client = await ensureDemoUser(db, `demo+${sessionId}.client@holdfast.demo`, "Maya Fernandes");
  const freelancer = await ensureDemoUser(db, `demo+${sessionId}.freelancer@holdfast.demo`, "Arjun Mehta");

  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, client.id)).for("update").limit(1);
    const [existing] = await tx.select({ id: deals.id }).from(deals).where(eq(deals.demoSessionId, sessionId)).limit(1);
    if (existing) return;

    const now = new Date();
    const [deal] = await tx.insert(deals).values({
      title: "Bakery landing page",
      brief: "A mobile-ready one-page bakery site with a menu section and order form, deployed to a public URL.",
      clientId: client.id,
      freelancerId: freelancer.id,
      demoSessionId: sessionId,
      inviteToken: randomBytes(24).toString("base64url"),
      status: "ACTIVE",
      currency: "USD",
      termsVersion: 1,
      clientSignedVersion: 1,
      freelancerSignedVersion: 1,
      clientSignedAt: now,
      freelancerSignedAt: now,
    }).returning();
    if (!deal) throw new Error("Demo agreement could not be created.");

    await tx.insert(mandates).values([
      { dealId: deal.id, userId: client.id, role: "client", maxTotalCents: 60_000, deadlineDays: 14, priorities: "Must work on mobile" },
      { dealId: deal.id, userId: freelancer.id, role: "freelancer", minTotalCents: 45_000, earliestDays: 10, preferredMilestones: 2, priorities: "Clear scope and prompt feedback" },
    ]);
    const milestoneRows = await tx.insert(milestones).values([
      { dealId: deal.id, idx: 1, title: "Structure & content", description: "Mobile-ready page structure, menu section, and copy review.", acceptanceCriteria: [{ criterion_id: "mobile", text: "Layout works at mobile viewport widths." }, { criterion_id: "menu", text: "Menu section shows supplied bakery items and prices." }], amountCents: 26_000, currency: "USD", dueInDays: 7 },
      { dealId: deal.id, idx: 2, title: "Order form & launch", description: "Validated order form, deployment, and final handoff.", acceptanceCriteria: [{ criterion_id: "form", text: "Order form validates required customer fields." }, { criterion_id: "launch", text: "Working deployment URL and handoff notes are provided." }], amountCents: 26_000, currency: "USD", dueInDays: 14 },
    ]).returning();
    const canonicalTerms = {
      title: deal.title,
      brief: deal.brief,
      total_cents: milestoneRows.reduce((total, item) => total + item.amountCents, 0),
      currency: deal.currency,
      milestones: milestoneRows.map((item) => ({ id: item.id, idx: item.idx, title: item.title, description: item.description, amount_cents: item.amountCents, due_in_days: item.dueInDays, acceptance_criteria: item.acceptanceCriteria })),
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(canonicalTerms)).digest("hex");
    await tx.insert(termsSnapshots).values({
      dealId: deal.id,
      version: 1,
      canonicalTerms,
      fingerprint,
      clientSignedAt: now,
      freelancerSignedAt: now,
    });
  });

  return { client, freelancer };
}
