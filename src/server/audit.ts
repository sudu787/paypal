import { getDatabase } from "@/server/db";
import { auditEvents } from "@/server/db/schema";

type AuditInput = typeof auditEvents.$inferInsert;

export async function writeAuditEvent(event: AuditInput): Promise<void> {
  const db = getDatabase();
  if (!db) throw new Error("DATABASE_URL is required to write audit events.");
  await db.insert(auditEvents).values(event);
}
