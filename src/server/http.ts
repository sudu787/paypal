import { randomUUID } from "node:crypto";
import { env } from "@/server/env";
import { AppError, toErrorResponse } from "@/server/errors";
import { logger } from "@/server/logger";

type RouteContext = { params: Promise<Record<string, string>> };
type Handler = (request: Request, requestId: string, context?: RouteContext) => Promise<Response>;
type Options = { mutation?: boolean; rateLimit?: { key: (request: Request) => string; limit: number; windowMs: number } };

function wrapApiRoute(handler: Handler, options: Options) {
  return async (request: Request, context?: RouteContext) => {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const startedAt = Date.now();
    try {
      if (options.mutation) {
        const origin = request.headers.get("origin");
        let validOrigin = false;
        try {
          validOrigin = Boolean(origin) && new URL(origin!).origin === new URL(env.APP_URL).origin;
        } catch {
          validOrigin = false;
        }
        if (!validOrigin) {
          throw new AppError("FORBIDDEN", "Request origin is not allowed.", 403);
        }
      }
      if (options.rateLimit) {
        const { rateLimit } = await import("@/server/rate-limit");
        const { key, limit, windowMs } = options.rateLimit;
        rateLimit(key(request), limit, windowMs);
      }
      const response = await handler(request, requestId, context);
      response.headers.set("x-request-id", requestId);
      logger.info({ requestId, method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      logger.error({ requestId, error, method: request.method, path: new URL(request.url).pathname });
      const response = toErrorResponse(error, requestId);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  };
}

export function apiRoute(handler: Handler, options: Options = {}) {
  const wrapped = wrapApiRoute(handler, options);
  return (request: Request) => wrapped(request);
}

export function apiRouteWithContext(handler: (request: Request, requestId: string, context: RouteContext) => Promise<Response>, options: Options = {}) {
  const wrapped = wrapApiRoute((request, requestId, context) => handler(request, requestId, context!), options);
  return (request: Request, context: RouteContext) => wrapped(request, context);
}
