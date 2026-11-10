import { apiRoute } from "@/server/http";
import { destroySession } from "@/server/auth/session";

export const POST = apiRoute(async () => {
  await destroySession();
  return Response.json({ ok: true });
}, { mutation: true });
