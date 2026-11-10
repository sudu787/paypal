import "dotenv/config";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/server/db/schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set before seeding.");
const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql, { schema });

async function main() {
  const definitions = [
    { email: process.env.DEMO_CLIENT_EMAIL ?? "maya@holdfast.demo", displayName: "Maya Fernandes", role: "user" },
    { email: process.env.DEMO_FREELANCER_EMAIL ?? "arjun@holdfast.demo", displayName: "Arjun Mehta", role: "user" },
    { email: process.env.DEMO_ADMIN_EMAIL ?? "admin@holdfast.demo", displayName: "HoldFast Admin", role: "admin" },
  ];
  const accounts = [] as Array<{ id: string; email: string; displayName: string }>;
  for (const definition of definitions) {
    const email = definition.email.toLowerCase();
    let [user] = await db.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
      .from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (!user) {
      const [created] = await db.insert(schema.users).values({
        email, displayName: definition.displayName, role: definition.role,
        passwordHash: await hash(randomBytes(48).toString("hex"), 12),
      }).returning({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName });
      user = created;
    }
    accounts.push(user);
  }

  const [existing] = await db.select({ id: schema.deals.id }).from(schema.deals).where(eq(schema.deals.title, "Bakery landing page")).limit(1);
  if (!existing) {
    const client = accounts[0]!;
    const freelancer = accounts[1]!;
    const [deal] = await db.insert(schema.deals).values({
      title: "Bakery landing page",
      brief: "A mobile-ready one-page bakery site with a menu section and order form, deployed to a public URL.",
      clientId: client.id,
      freelancerId: freelancer.id,
      inviteToken: randomBytes(24).toString("base64url"),
      status: "ACTIVE",
      currency: "USD",
      termsVersion: 1,
      clientSignedVersion: 1,
      freelancerSignedVersion: 1,
      clientSignedAt: new Date(),
      freelancerSignedAt: new Date(),
    }).returning();
    await db.insert(schema.mandates).values([
      { dealId: deal!.id, userId: client.id, role: "client", maxTotalCents: 60_000, deadlineDays: 14, priorities: "Must work on mobile" },
      { dealId: deal!.id, userId: freelancer.id, role: "freelancer", minTotalCents: 45_000, earliestDays: 10, preferredMilestones: 2, priorities: "Clear scope and prompt feedback" },
    ]);
    const milestoneRows = await db.insert(schema.milestones).values([
      { dealId: deal!.id, idx: 1, title: "Structure & content", description: "Mobile-ready page structure, menu section, and copy review.", acceptanceCriteria: [{ criterion_id: "mobile", text: "Layout works at mobile viewport widths." }, { criterion_id: "menu", text: "Menu section shows supplied bakery items and prices." }], amountCents: 26_000, currency: "USD", dueInDays: 7 },
      { dealId: deal!.id, idx: 2, title: "Order form & launch", description: "Validated order form, deployment, and final handoff.", acceptanceCriteria: [{ criterion_id: "form", text: "Order form validates required customer fields." }, { criterion_id: "launch", text: "Working deployment URL and handoff notes are provided." }], amountCents: 26_000, currency: "USD", dueInDays: 14 },
    ]).returning();
    const terms = { title: "Bakery landing page", total_cents: 52_000, currency: "USD", milestones: milestoneRows.map(({ id, title, amountCents, acceptanceCriteria }) => ({ id, title, amount_cents: amountCents, acceptance_criteria: acceptanceCriteria })) };
    const canonical = JSON.stringify(terms);
    const { createHash } = await import("node:crypto");
    await db.insert(schema.termsSnapshots).values({ dealId: deal!.id, version: 1, canonicalTerms: terms, fingerprint: createHash("sha256").update(canonical).digest("hex"), clientSignedAt: new Date(), freelancerSignedAt: new Date() });
    console.info("Created sample Bakery landing page deal with two milestones.");
  }
  console.info("Seeded HoldFast demo client, freelancer, and admin accounts.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await sql.end(); });
