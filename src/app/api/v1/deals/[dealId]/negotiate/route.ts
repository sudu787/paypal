import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { negotiateDeal } from "@/server/ai/negotiation";

export const POST = apiRouteWithContext(async (_request, _requestId, context) => {
  const user = await requireUser();
  const dealId = (await context.params).dealId;
  const result = await negotiateDeal(dealId, user.id);
  return Response.json(result);
}, { mutation: true, rateLimit: { key: (request) => `negotiate:${new URL(request.url).pathname}`, limit: 5, windowMs: 60 * 60_000 } });
