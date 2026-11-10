import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { env } from "@/server/env";
import { getDatabase } from "@/server/db";
import { users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { eq } from "drizzle-orm";

export type SessionData = {
  userId?: string;
  demoSessionId?: string;
};

const sessionOptions: SessionOptions = {
  cookieName: "hf_session",
  password: env.SESSION_SECRET,
  cookieOptions: {
    secure: env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  },
};

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions);
}

export async function requireUser() {
  const session = await getSession();
  if (!session.userId) throw new AppError("UNAUTHENTICATED", "Sign in to continue.", 401);
  const db = getDatabase();
  if (!db) throw new AppError("CONFIGURATION_ERROR", "Database is not configured.", 503);
  const [user] = await db.select({
    id: users.id,
    email: users.email,
    displayName: users.displayName,
    role: users.role,
  }).from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) {
    session.destroy();
    throw new AppError("UNAUTHENTICATED", "Session has expired. Sign in again.", 401);
  }
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") throw new AppError("FORBIDDEN", "Administrator access is required.", 403);
  return user;
}

export async function saveSession(userId: string, demoSessionId?: string) {
  const session = await getSession();
  session.userId = userId;
  if (demoSessionId) session.demoSessionId = demoSessionId;
  await session.save();
}

export async function destroySession() {
  const session = await getSession();
  session.destroy();
}
