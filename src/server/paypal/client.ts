import { z } from "zod";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { toPayPalAmount } from "@/lib/money";

export class PayPalError extends AppError {
  constructor(
    message: string,
    public readonly providerStatus: number,
    public readonly issue?: string,
    public readonly debugId?: string,
    public readonly uncertain = false,
  ) {
    super("PAYPAL_ERROR", message, providerStatus >= 400 && providerStatus < 500 ? providerStatus : 502, {
      issue,
      debug_id: debugId,
      outcome_uncertain: uncertain,
    });
    this.name = "PayPalError";
  }
}

const accessTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const linkSchema = z.object({ rel: z.string(), href: z.string().url() });
const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  links: z.array(linkSchema).optional().default([]),
  purchase_units: z.array(z.object({
    reference_id: z.string().optional(),
    amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
    payments: z.object({ authorizations: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).optional() }).optional(),
  }).passthrough()).optional(),
}).passthrough();
const mutationSchema = z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough();

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | undefined;
let tokenPromise: Promise<string> | undefined;

function requireCredentials() {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new AppError("CONFIGURATION_ERROR", "PayPal sandbox credentials are not configured.", 503);
  }
}

async function getAccessToken(): Promise<string> {
  requireCredentials();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const authorization = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PayPalError("Could not reach PayPal sandbox token service.", 502, "NETWORK_ERROR", undefined, true);
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw parsePayPalError(response.status, payload);
    const parsed = accessTokenSchema.safeParse(payload);
    if (!parsed.success) throw new PayPalError("PayPal returned an invalid OAuth response.", 502, "INVALID_RESPONSE", undefined, true);
    cachedToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return parsed.data.access_token;
  })().finally(() => { tokenPromise = undefined; });
  return tokenPromise;
}

export async function verifySandboxCredentials() {
  await getAccessToken();
}

function parsePayPalError(status: number, payload: unknown): PayPalError {
  const body = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const details = Array.isArray(body.details) ? body.details[0] as Record<string, unknown> | undefined : undefined;
  const issue = typeof details?.issue === "string" ? details.issue : typeof body.name === "string" ? body.name : "PAYPAL_ERROR";
  const debugId = typeof body.debug_id === "string" ? body.debug_id : undefined;
  const message = typeof body.message === "string" ? body.message : "PayPal sandbox request failed.";
  const uncertain = status >= 500 || status === 409;
  return new PayPalError(message, status, issue, debugId, uncertain);
}

export function isValidPayPalRequestId(requestId: string) {
  return requestId.length <= 38 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
}

export type CaptureOutcome = "COMPLETED" | "PENDING" | "FAILED" | "UNKNOWN";

export function normalizeCaptureStatus(status?: string): CaptureOutcome {
  const normalized = status?.toUpperCase();
  if (normalized === "COMPLETED") return "COMPLETED";
  if (normalized === "PENDING") return "PENDING";
  if (normalized === "DECLINED" || normalized === "FAILED" || normalized === "DENIED") return "FAILED";
  return "UNKNOWN";
}

function assertRequestId(requestId: string) {
  if (!isValidPayPalRequestId(requestId)) {
    throw new AppError("VALIDATION_ERROR", "A plain UUID operation ID is required for PayPal idempotency.", 400);
  }
}

async function paypalRequest<T>(path: string, options: {
  method?: "GET" | "POST";
  body?: unknown;
  requestId?: string;
} = {}): Promise<T> {
  const token = await getAccessToken();
  if (options.requestId) assertRequestId(options.requestId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;

  let response: Response;
  try {
    response = await fetch(`${env.PAYPAL_API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PayPalError("PayPal sandbox request timed out or lost its connection.", 502, "NETWORK_ERROR", undefined, true);
  }

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw parsePayPalError(response.status, payload);
  return payload as T;
}

export type CreateOrderInput = {
  milestoneId: string;
  amountCents: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
};

export async function createAuthorizeOrder(input: CreateOrderInput) {
  const raw = await paypalRequest<unknown>("/v2/checkout/orders", {
    method: "POST",
    requestId: input.requestId,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [{
        reference_id: input.milestoneId,
        custom_id: `milestone:${input.milestoneId}`,
        amount: toPayPalAmount(input.amountCents, input.currency),
      }],
      application_context: {
        return_url: input.returnUrl,
        cancel_url: input.cancelUrl,
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
      },
    },
  });
  const order = orderSchema.parse(raw);
  const approval = order.links.find((link) => link.rel === "payer-action" || link.rel === "approve");
  if (!approval) throw new PayPalError("PayPal created an order without an approval link.", 502, "MISSING_APPROVAL_LINK", undefined, true);
  return { id: order.id, status: order.status, approveUrl: approval.href };
}

export async function getOrder(orderId: string) {
  return orderSchema.parse(await paypalRequest<unknown>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`));
}

export async function authorizeOrder(orderId: string, requestId: string) {
  const raw = await paypalRequest<unknown>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    method: "POST",
    requestId,
    body: {},
  });
  return orderSchema.parse(raw);
}

export async function getAuthorization(authorizationId: string) {
  return mutationSchema.extend({ expiration_time: z.string().optional(), amount: z.object({ currency_code: z.string(), value: z.string() }).optional() }).passthrough()
    .parse(await paypalRequest<unknown>(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`));
}

export async function getCapture(captureId: string) {
  return mutationSchema.parse(await paypalRequest<unknown>(`/v2/payments/captures/${encodeURIComponent(captureId)}`));
}

export async function captureAuthorization(input: { authorizationId: string; amountCents: number; currency: string; requestId: string; invoiceId: string }) {
  const raw = await paypalRequest<unknown>(`/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`, {
    method: "POST",
    requestId: input.requestId,
    body: {
      amount: toPayPalAmount(input.amountCents, input.currency),
      final_capture: true,
      invoice_id: input.invoiceId.slice(0, 127),
      note_to_payer: "HoldFast milestone release",
    },
  });
  return mutationSchema.parse(raw);
}

export async function voidAuthorization(authorizationId: string, requestId: string) {
  return paypalRequest<void>(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, {
    method: "POST",
    requestId,
    body: {},
  });
}

export async function verifyWebhookSignature(input: {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: Record<string, unknown>;
}) {
  const result = z.object({ verification_status: z.enum(["SUCCESS", "FAILURE"]) }).parse(await paypalRequest<unknown>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: input.authAlgo,
      cert_url: input.certUrl,
      transmission_id: input.transmissionId,
      transmission_sig: input.transmissionSig,
      transmission_time: input.transmissionTime,
      webhook_id: input.webhookId,
      webhook_event: input.webhookEvent,
    },
  }));
  return result.verification_status === "SUCCESS";
}
