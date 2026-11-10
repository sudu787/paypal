import "dotenv/config";
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
  const email = (process.env.DEMO_ADMIN_EMAIL ?? "admin@holdfast.demo").toLowerCase();
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) {
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, existing.id));
  } else {
    await db.insert(schema.users).values({
      email,
      displayName: "HoldFast Admin",
      role: "admin",
      passwordHash: await hash(crypto.randomUUID() + crypto.randomUUID(), 12),
    });
  }
  console.info("Seeded the HoldFast admin identity. Demo client and freelancer data is isolated per browser demo session.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await sql.end(); });
