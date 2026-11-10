import { apiRoute } from "@/server/http";
import { requireUser } from "@/server/auth/session";

export const GET = apiRoute(async () => {
  const { id, email, displayName, role, demoSessionId } = await requireUser();
  return Response.json({ user: { id, email, displayName, role, isDemo: Boolean(demoSessionId) } });
});
