import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiRoute } from "@/server/http";
import { getDatabase } from "@/server/db";
import { users } from "@/server/db/schema";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { saveSession } from "@/server/auth/session";
import { writeAuditEvent } from "@/server/audit";

const schema = z.object({ persona: z.enum(["client", "freelancer"]) });

export const POST = apiRoute(async (request) => {
  if (!env.DEMO_MODE) throw new AppError("FORBIDDEN", "Demo access is disabled.", 403);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Choose a valid demo persona.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const email = parsed.data.persona === "client" ? env.DEMO_CLIENT_EMAIL : env.DEMO_FREELANCER_EMAIL;
  const [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
    .from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new AppError("CONFIGURATION_ERROR", "Demo accounts are not seeded yet. Run the database seed command.", 503);
  await saveSession(user.id);
  await writeAuditEvent({ category: "AUTH", eventType: "DEMO_LOGIN", actorType: "USER", actorUserId: user.id, note: parsed.data.persona });
  return Response.json({ user });
}, { mutation: true, rateLimit: { key: (request) => `demo:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
