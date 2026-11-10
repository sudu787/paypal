import { compare } from "bcryptjs";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { getDatabase } from "@/server/db";
import { users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { saveSession } from "@/server/auth/session";
import { writeAuditEvent } from "@/server/audit";
import { eq } from "drizzle-orm";

const schema = z.object({ email: z.email().transform((value) => value.trim().toLowerCase()), password: z.string().min(1).max(128) });

export const POST = apiRoute(async (request) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Enter a valid email and password.", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
  if (!user || !(await compare(parsed.data.password, user.passwordHash))) {
    throw new AppError("UNAUTHENTICATED", "Email or password is incorrect.", 401);
  }
  await saveSession(user.id);
  await writeAuditEvent({ category: "AUTH", eventType: "USER_LOGGED_IN", actorType: "USER", actorUserId: user.id });
  return Response.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } });
}, { mutation: true, rateLimit: { key: (request) => `login:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
