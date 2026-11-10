import { apiRouteWithContext } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { verifySubmission } from "@/server/ai/verifier";

export const POST = apiRouteWithContext(async (_request, _requestId, context) => {
  const user = await requireUser();
  const milestoneId = (await context.params).milestoneId;
  return Response.json(await verifySubmission(milestoneId, user.id));
}, { mutation: true, rateLimit: { key: (request) => `verify:${new URL(request.url).pathname}`, limit: 10, windowMs: 60 * 60_000 } });
