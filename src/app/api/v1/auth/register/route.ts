import { hash } from "bcryptjs";
import { z } from "zod";
import { apiRoute } from "@/server/http";
import { getDatabase } from "@/server/db";
import { users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { saveSession } from "@/server/auth/session";
import { writeAuditEvent } from "@/server/audit";

const schema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(80),
});

export const POST = apiRoute(async (request) => {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Provide a valid email, name, and password (at least 12 characters).", 400);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const passwordHash = await hash(parsed.data.password, 12);
  let user;
  try {
    [user] = await db.insert(users).values({
      email: parsed.data.email,
      passwordHash,
      displayName: parsed.data.displayName,
    }).returning({ id: users.id, email: users.email, displayName: users.displayName });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new AppError("CONFLICT", "An account with this email already exists.", 409);
    }
    throw error;
  }
  await saveSession(user.id);
  await writeAuditEvent({ category: "AUTH", eventType: "USER_REGISTERED", actorType: "USER", actorUserId: user.id });
  return Response.json({ user }, { status: 201 });
}, { mutation: true, rateLimit: { key: (request) => `register:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 5, windowMs: 60_000 } });
