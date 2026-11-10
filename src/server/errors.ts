export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "AI_UNAVAILABLE"
  | "PAYPAL_ERROR"
  | "AI_UNAVAILABLE"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorResponse(error: unknown, requestId: string) {
  if (error instanceof AppError) {
    return Response.json(
      { error: { code: error.code, message: error.message, details: error.details, request_id: requestId } },
      { status: error.status },
    );
  }
  return Response.json(
    { error: { code: "INTERNAL", message: "An unexpected error occurred.", request_id: requestId } },
    { status: 500 },
  );
}
