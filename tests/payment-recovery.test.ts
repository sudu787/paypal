import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { auditEvents, captures, deals, durableJobs, milestones, paymentOperations, paypalOrders, users, webhookEvents } from "@/server/db/schema";
import { processWebhook, recoverPaymentOperation } from "@/server/jobs/worker";

const db = getDatabase();
const enabled = Boolean(db && process.env.DATABASE_URL);

type Call = { method: string; path: string; requestId: string | null };
type Handler = (call: Call) => { status: number; body?: unknown } | undefined;

// Replace fetch for one test. Unhandled PayPal paths fail the test loudly.
function stubPayPal(t: TestContext, handler: Handler) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", path: url.pathname, requestId: headers.get("PayPal-Request-Id") };
    if (call.path === "/v1/oauth2/token") return Response.json({ access_token: "test-token", expires_in: 3600 });
    calls.push(call);
    const result = handler(call);
    if (!result) throw new Error(`Unexpected PayPal call ${call.method} ${call.path}`);
    return result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.body ?? {}, { status: result.status });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

// One client, one active deal, one milestone, and an AUTHORIZED PayPal order.
async function seedAuthorizedMilestone(t: TestContext, milestone: Partial<typeof milestones.$inferInsert> = {}) {
  const userId = randomUUID();
  const dealId = randomUUID();
  const milestoneId = randomUUID();
  const fundingOperationId = randomUUID();
  const orderRowId = randomUUID();
  const authorizationId = `AUTH-${randomUUID()}`;
  const amountCents = 20_000;
  await db!.insert(users).values({ id: userId, email: `${userId}@example.test`, passwordHash: "test", displayName: "Recovery Test" });
  await db!.insert(deals).values({ id: dealId, title: "Recovery test", brief: "A test agreement for payment recovery.", clientId: userId, inviteToken: randomUUID(), status: "ACTIVE", termsVersion: 1 });
  await db!.insert(milestones).values({ id: milestoneId, dealId, idx: 1, title: "Test work", description: "", acceptanceCriteria: [{ criterion_id: "criterion-1", text: "A visible test result" }], amountCents, currency: "USD", dueInDays: 7, workStatus: "SUBMITTED", authorizationStatus: "AUTHORIZED", ...milestone });
  await db!.insert(paymentOperations).values({ id: fundingOperationId, operationType: "CREATE_ORDER", milestoneId, actorUserId: userId, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), requestParameters: { amount_cents: amountCents, currency: "USD" }, status: "SUCCEEDED" });
  await db!.insert(paypalOrders).values({ id: orderRowId, operationId: fundingOperationId, milestoneId, createdBy: userId, amountCents, currency: "USD", paypalOrderId: `ORDER-${randomUUID()}`, status: "AUTHORIZED", authorizationId, authorizationStatus: "CREATED" });
  t.after(async () => {
    const operationIds = (await db!.select({ id: paymentOperations.id }).from(paymentOperations).where(eq(paymentOperations.milestoneId, milestoneId))).map((row) => row.id);
    await db!.delete(auditEvents).where(eq(auditEvents.dealId, dealId));
    if (operationIds.length) await db!.delete(durableJobs).where(inArray(durableJobs.resourceId, operationIds));
    await db!.delete(captures).where(eq(captures.milestoneId, milestoneId));
    await db!.delete(paypalOrders).where(eq(paypalOrders.milestoneId, milestoneId));
    await db!.delete(paymentOperations).where(eq(paymentOperations.milestoneId, milestoneId));
    await db!.delete(milestones).where(eq(milestones.id, milestoneId));
    await db!.delete(deals).where(eq(deals.id, dealId));
    await db!.delete(users).where(eq(users.id, userId));
  });
  return { userId, dealId, milestoneId, orderRowId, authorizationId, amountCents };
}

async function seedCaptureOperation(seed: Awaited<ReturnType<typeof seedAuthorizedMilestone>>, status: string, providerCaptureId: string | null) {
  const operationId = randomUUID();
  await db!.insert(paymentOperations).values({ id: operationId, operationType: "CAPTURE", milestoneId: seed.milestoneId, actorUserId: seed.userId, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), requestParameters: { amount_cents: seed.amountCents, authorization_id: seed.authorizationId, currency: "USD", final_capture: true }, status, providerObjectId: providerCaptureId, attemptCount: 1 });
  await db!.insert(captures).values({ operationId, milestoneId: seed.milestoneId, paypalOrderRowId: seed.orderRowId, authorizationId: seed.authorizationId, amountCents: seed.amountCents, finalCapture: true, releasedBy: seed.userId, status, paypalCaptureId: providerCaptureId });
  return operationId;
}

test("a pending capture with a known ID converges by reading the capture, not the authorization", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { captureStatus: "PENDING" });
  const captureId = `CAP-${randomUUID()}`;
  const operationId = await seedCaptureOperation(seed, "PENDING", captureId);
  const calls = stubPayPal(t, (call) => call.path === `/v2/payments/captures/${captureId}` ? { status: 200, body: { id: captureId, status: "COMPLETED" } } : undefined);

  await recoverPaymentOperation(operationId);

  assert.deepEqual(calls.map((call) => call.path), [`/v2/payments/captures/${captureId}`]);
  const [milestone] = await db!.select().from(milestones).where(eq(milestones.id, seed.milestoneId));
  const [operation] = await db!.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  assert.equal(milestone?.captureStatus, "COMPLETED");
  assert.equal(milestone?.workStatus, "RELEASED");
  assert.equal(operation?.status, "SUCCEEDED");
});

test("a capture still pending at PayPal stays pending and is never shown as completed", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { captureStatus: "PENDING" });
  const captureId = `CAP-${randomUUID()}`;
  const operationId = await seedCaptureOperation(seed, "PENDING", captureId);
  stubPayPal(t, (call) => call.path === `/v2/payments/captures/${captureId}` ? { status: 200, body: { id: captureId, status: "PENDING" } } : undefined);

  await recoverPaymentOperation(operationId);

  const [milestone] = await db!.select().from(milestones).where(eq(milestones.id, seed.milestoneId));
  const [operation] = await db!.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  assert.equal(milestone?.captureStatus, "PENDING");
  assert.equal(milestone?.workStatus, "SUBMITTED");
  assert.equal(operation?.status, "PENDING");
});

test("a capture with a lost response is retried with the original operation UUID", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { captureStatus: "UNKNOWN" });
  const operationId = await seedCaptureOperation(seed, "UNKNOWN", null);
  const captureId = `CAP-${randomUUID()}`;
  const calls = stubPayPal(t, (call) => {
    if (call.path === `/v2/payments/authorizations/${seed.authorizationId}`) return { status: 200, body: { id: seed.authorizationId, status: "CREATED", amount: { currency_code: "USD", value: "200.00" } } };
    if (call.path === `/v2/payments/authorizations/${seed.authorizationId}/capture`) return { status: 201, body: { id: captureId, status: "COMPLETED" } };
    return undefined;
  });

  await recoverPaymentOperation(operationId);

  const capture = calls.find((call) => call.path.endsWith("/capture"));
  assert.equal(capture?.requestId, operationId);
  const [stored] = await db!.select().from(captures).where(eq(captures.operationId, operationId));
  assert.equal(stored?.status, "COMPLETED");
  assert.equal(stored?.paypalCaptureId, captureId);
});

test("capture recovery refuses an authorization whose amount differs from the signed request", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { captureStatus: "UNKNOWN" });
  const operationId = await seedCaptureOperation(seed, "UNKNOWN", null);
  const calls = stubPayPal(t, (call) => call.path === `/v2/payments/authorizations/${seed.authorizationId}` ? { status: 200, body: { id: seed.authorizationId, status: "CREATED", amount: { currency_code: "USD", value: "999.00" } } } : undefined);

  await assert.rejects(recoverPaymentOperation(operationId), /amount differs/);
  assert.equal(calls.some((call) => call.path.endsWith("/capture")), false);
  const [milestone] = await db!.select().from(milestones).where(eq(milestones.id, seed.milestoneId));
  assert.equal(milestone?.captureStatus, "UNKNOWN");
});

test("a void with a lost response is retried with the original UUID and cancels the milestone", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { workStatus: "NOT_STARTED", authorizationStatus: "UNKNOWN" });
  const operationId = randomUUID();
  await db!.insert(paymentOperations).values({ id: operationId, operationType: "VOID", milestoneId: seed.milestoneId, actorUserId: seed.userId, idempotencyKey: randomUUID(), requestFingerprint: `${seed.authorizationId}:${seed.milestoneId}`, requestParameters: { authorization_id: seed.authorizationId }, status: "UNKNOWN", attemptCount: 1 });
  const calls = stubPayPal(t, (call) => {
    if (call.path === `/v2/payments/authorizations/${seed.authorizationId}`) return { status: 200, body: { id: seed.authorizationId, status: "CREATED" } };
    if (call.path === `/v2/payments/authorizations/${seed.authorizationId}/void`) return { status: 204 };
    return undefined;
  });

  await recoverPaymentOperation(operationId);

  assert.equal(calls.find((call) => call.path.endsWith("/void"))?.requestId, operationId);
  const [milestone] = await db!.select().from(milestones).where(eq(milestones.id, seed.milestoneId));
  assert.equal(milestone?.authorizationStatus, "VOIDED");
  assert.equal(milestone?.workStatus, "CANCELLED");
});

test("an authorization with a lost response is completed from the approved order with the original UUID", { skip: !enabled }, async (t) => {
  const seed = await seedAuthorizedMilestone(t, { workStatus: "NOT_STARTED", authorizationStatus: "UNKNOWN" });
  const [order] = await db!.select().from(paypalOrders).where(eq(paypalOrders.id, seed.orderRowId));
  await db!.update(paypalOrders).set({ status: "UNKNOWN", authorizationId: null, authorizationStatus: null }).where(eq(paypalOrders.id, seed.orderRowId));
  const operationId = randomUUID();
  await db!.insert(paymentOperations).values({ id: operationId, operationType: "AUTHORIZE", milestoneId: seed.milestoneId, actorUserId: seed.userId, idempotencyKey: `authorize:${order!.operationId}`, requestFingerprint: randomUUID(), requestParameters: { paypal_order_id: order!.paypalOrderId }, status: "UNKNOWN", attemptCount: 1 });
  const calls = stubPayPal(t, (call) => {
    if (call.path === `/v2/checkout/orders/${order!.paypalOrderId}` && call.method === "GET") return { status: 200, body: { id: order!.paypalOrderId, status: "APPROVED" } };
    if (call.path === `/v2/checkout/orders/${order!.paypalOrderId}/authorize`) return { status: 201, body: { id: order!.paypalOrderId, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: seed.authorizationId, status: "CREATED" }] } }] } };
    return undefined;
  });

  await recoverPaymentOperation(operationId);

  assert.equal(calls.find((call) => call.path.endsWith("/authorize"))?.requestId, operationId);
  const [milestone] = await db!.select().from(milestones).where(eq(milestones.id, seed.milestoneId));
  const [storedOrder] = await db!.select().from(paypalOrders).where(eq(paypalOrders.id, seed.orderRowId));
  assert.equal(milestone?.authorizationStatus, "AUTHORIZED");
  assert.equal(storedOrder?.authorizationId, seed.authorizationId);
});

test("a verified webhook for an unknown capture stays unprocessed so it can be retried", { skip: !enabled }, async (t) => {
  const eventId = `test-event-${randomUUID()}`;
  await db!.insert(webhookEvents).values({ id: eventId, eventType: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: `CAP-${randomUUID()}`, verified: true, payload: { id: eventId, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { status: "COMPLETED" } } });
  t.after(async () => { await db!.delete(webhookEvents).where(eq(webhookEvents.id, eventId)); });

  await assert.rejects(processWebhook(eventId), /not linked/);
  const [stored] = await db!.select().from(webhookEvents).where(eq(webhookEvents.id, eventId));
  assert.equal(stored?.processedAt, null);
});

test("an unverified webhook is never processed", { skip: !enabled }, async (t) => {
  const eventId = `test-event-${randomUUID()}`;
  await db!.insert(webhookEvents).values({ id: eventId, eventType: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: "CAP-X", verified: false, payload: { id: eventId } });
  t.after(async () => { await db!.delete(webhookEvents).where(eq(webhookEvents.id, eventId)); });

  await assert.rejects(processWebhook(eventId), /Verified webhook event is unavailable/);
});
