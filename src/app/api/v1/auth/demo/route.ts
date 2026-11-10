import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiRoute } from "@/server/http";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { getSession, saveSession } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { users } from "@/server/db/schema";
import { writeAuditEvent } from "@/server/audit";
import { ensureDemoSession } from "@/server/auth/demo-fixture";

const schema = z.object({ persona: z.enum(["client", "freelancer", "admin"]) });

export const POST = apiRoute(async (request) => {
  if (!env.DEMO_MODE) throw new AppError("FORBIDDEN", "Demo access is disabled.", 403);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Choose a valid demo persona.", 400);
  let user;
  if (parsed.data.persona === "admin") {
    const db = getDatabase();
    if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
    [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role })
      .from(users).where(eq(users.email, env.DEMO_ADMIN_EMAIL.toLowerCase())).limit(1);
    if (!user || user.role !== "admin") throw new AppError("CONFIGURATION_ERROR", "Run the database seed command before using the demo admin persona.", 503);
    await saveSession(user.id);
  } else {
    const session = await getSession();
    const sessionId = session.demoSessionId && z.uuid().safeParse(session.demoSessionId).success ? session.demoSessionId : randomUUID();
    const demoUsers = await ensureDemoSession(sessionId);
    user = parsed.data.persona === "client" ? demoUsers.client : demoUsers.freelancer;
    await saveSession(user.id, sessionId);
  }
  await writeAuditEvent({ category: "AUTH", eventType: "DEMO_LOGIN", actorType: "USER", actorUserId: user.id, note: parsed.data.persona });
  return Response.json({ user });
}, { mutation: true, rateLimit: { key: (request) => `demo:${request.headers.get("x-forwarded-for") ?? "unknown"}`, limit: 10, windowMs: 60_000 } });
