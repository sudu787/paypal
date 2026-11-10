import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { env } from "@/server/env";
import * as schema from "@/server/db/schema";

type Database = PostgresJsDatabase<typeof schema>;
const globalForDb = globalThis as typeof globalThis & { holdfastSql?: ReturnType<typeof postgres>; holdfastDb?: Database };

export function getDatabase(): Database | null {
  if (!env.DATABASE_URL) return null;
  if (!globalForDb.holdfastSql) {
    globalForDb.holdfastSql = postgres(env.DATABASE_URL, { max: env.NODE_ENV === "production" ? 10 : 2, idle_timeout: 20 });
    globalForDb.holdfastDb = drizzle(globalForDb.holdfastSql, { schema });
  }
  return globalForDb.holdfastDb ?? null;
}

export async function pingDatabase() {
  const db = getDatabase();
  if (!db) return "skipped" as const;
  await db.execute(sql`select 1`);
  return "connected" as const;
}

export async function closeDatabase() {
  await globalForDb.holdfastSql?.end({ timeout: 5 });
  globalForDb.holdfastSql = undefined;
  globalForDb.holdfastDb = undefined;
}
