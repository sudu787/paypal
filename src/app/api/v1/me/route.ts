import { apiRoute } from "@/server/http";
import { requireUser } from "@/server/auth/session";

export const GET = apiRoute(async () => Response.json({ user: await requireUser() }));
