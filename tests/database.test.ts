import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { auditEvents, captures, deals, durableJobs, milestones, paymentOperations, paypalOrders, users, webhookEvents } from "@/server/db/schema";
import { claimJob, processWebhook, recoverPaymentOperation, renewJobLease } from "@/server/jobs/worker";

const db = getDatabase();
const enabled = Boolean(db && process.env.DATABASE_URL);

test("Postgres job claiming grants one active lease to one concurrent worker", { skip: !enabled }, async (t) => {
  const resourceId = `test-${randomUUID()}`;
  const [job] = await db!.insert(durableJobs).values({ kind: "TEST_LEASE", resourceId, status: "QUEUED" }).returning();
  t.after(async () => { await db!.delete(durableJobs).where(eq(durableJobs.id, job!.id)); });
  const claimed = await Promise.all([claimJob(), claimJob()]);
  assert.equal(claimed.filter((entry) => entry?.id === job!.id).length, 1);
  const [stored] = await db!.select().from(durableJobs).where(eq(durableJobs.id, job!.id));
  assert.equal(stored?.status, "RUNNING");
  assert.equal(stored?.attempts, 1);
});

test("claiming a job recovers its expired lease and increments the attempt", { skip: !enabled }, async (t) => {
  const resourceId = `expired-${randomUUID()}`;
  const [job] = await db!.insert(durableJobs).values({
    kind: "TEST_EXPIRED_LEASE",
    resourceId,
    status: "RUNNING",
    leaseOwner: "stopped-worker",
    leaseExpiresAt: new Date(Date.now() - 1_000),
    heartbeatAt: new Date(Date.now() - 61_000),
    runAfter: new Date(Date.now() - 61_000),
    attempts: 1,
  }).returning();
  t.after(async () => { await db!.delete(durableJobs).where(eq(durableJobs.id, job!.id)); });

  const recovered = await claimJob();
  assert.equal(recovered?.id, job!.id);
  assert.equal(recovered?.status, "RUNNING");
  assert.equal(recovered?.attempts, 2);
  assert.notEqual(recovered?.leaseOwner, "stopped-worker");
  assert.ok((recovered?.leaseExpiresAt?.getTime() ?? 0) > Date.now());
});

test("job heartbeat only extends a lease owned by the running worker", { skip: !enabled }, async (t) => {
  const resourceId = `heartbeat-${randomUUID()}`;
  const workerId = `worker-${randomUUID()}`;
  const [job] = await db!.insert(durableJobs).values({
    kind: "TEST_HEARTBEAT",
    resourceId,
    status: "RUNNING",
    leaseOwner: workerId,
    leaseExpiresAt: new Date(Date.now() - 1_000),
    heartbeatAt: new Date(Date.now() - 61_000),
  }).returning();
  t.after(async () => { await db!.delete(durableJobs).where(eq(durableJobs.id, job!.id)); });

  const now = new Date();
  assert.equal(await renewJobLease(job!.id, workerId, now), true);
  assert.equal(await renewJobLease(job!.id, "another-worker", now), false);
  const [stored] = await db!.select().from(durableJobs).where(eq(durableJobs.id, job!.id));
  assert.equal(stored?.heartbeatAt?.getTime(), now.getTime());
  assert.equal(stored?.leaseExpiresAt?.getTime(), now.getTime() + 60_000);
});

test("uncertain order recovery resumes the stored parameters with the original operation UUID", { skip: !enabled }, async (t) => {
  const userId = randomUUID();
  const dealId = randomUUID();
  const milestoneId = randomUUID();
  const operationId = randomUUID();
  const orderRowId = randomUUID();
  const idemKey = randomUUID();
  const amountCents = 52_000;
  const returnUrl = "http://localhost:3000/api/v1/paypal/return";
  const cancelUrl = "http://localhost:3000/api/v1/paypal/cancel";

  await db!.insert(users).values({ id: userId, email: `${userId}@example.test`, passwordHash: "test", displayName: "Recovery Test" });
  await db!.insert(deals).values({ id: dealId, title: "Recovery test", brief: "A test agreement for payment recovery.", clientId: userId, inviteToken: randomUUID(), status: "ACTIVE", termsVersion: 1 });
  await db!.insert(milestones).values({ id: milestoneId, dealId, idx: 1, title: "Test work", description: "", acceptanceCriteria: [{ criterion_id: "criterion-1", text: "A visible test result" }], amountCents, currency: "USD", dueInDays: 7, authorizationStatus: "UNKNOWN" });
  await db!.insert(paymentOperations).values({
    id: operationId,
    operationType: "CREATE_ORDER",
    milestoneId,
    actorUserId: userId,
    idempotencyKey: idemKey,
    requestFingerprint: `${milestoneId}:${amountCents}:USD`,
    requestParameters: { amount_cents: amountCents, currency: "USD", return_url: returnUrl, cancel_url: cancelUrl },
    status: "UNKNOWN",
    attemptCount: 1,
  });
  await db!.insert(paypalOrders).values({ id: orderRowId, operationId, milestoneId, createdBy: userId, amountCents, currency: "USD", status: "UNKNOWN" });
  t.after(async () => {
    await db!.delete(auditEvents).where(eq(auditEvents.dealId, dealId));
    await db!.delete(paypalOrders).where(eq(paypalOrders.id, orderRowId));
    await db!.delete(paymentOperations).where(eq(paymentOperations.id, operationId));
    await db!.delete(milestones).where(eq(milestones.id, milestoneId));
    await db!.delete(deals).where(eq(deals.id, dealId));
    await db!.delete(users).where(eq(users.id, userId));
  });

  let originalRequest: Parameters<typeof import("@/server/paypal/client").createAuthorizeOrder>[0] | undefined;
  await recoverPaymentOperation(operationId, async (input) => {
    originalRequest = input;
    return { id: "ORDER-RECOVERED", status: "CREATED", approveUrl: "https://paypal.example/approve" };
  });

  assert.deepEqual(originalRequest, { milestoneId, amountCents, currency: "USD", returnUrl, cancelUrl, requestId: operationId });
  const [storedOperation] = await db!.select().from(paymentOperations).where(eq(paymentOperations.id, operationId));
  const [storedOrder] = await db!.select().from(paypalOrders).where(eq(paypalOrders.id, orderRowId));
  assert.equal(storedOperation?.status, "SUCCEEDED");
  assert.equal(storedOperation?.providerObjectId, "ORDER-RECOVERED");
  assert.equal(storedOrder?.status, "CREATED");
  assert.equal(storedOrder?.paypalOrderId, "ORDER-RECOVERED");
});

test("PayPal capture webhook is applied once and duplicate processing is harmless", { skip: !enabled }, async (t) => {
  const userId = randomUUID();
  const dealId = randomUUID();
  const milestoneId = randomUUID();
  const operationId = randomUUID();
  const orderId = randomUUID();
  const captureId = randomUUID();
  const eventId = `test-event-${randomUUID()}`;
  const externalOrderId = `ORDER-${randomUUID()}`;
  const authorizationId = `AUTH-${randomUUID()}`;

  await db!.insert(users).values({ id: userId, email: `${userId}@example.test`, passwordHash: "test", displayName: "Webhook Test" });
  await db!.insert(deals).values({ id: dealId, title: "Webhook test", brief: "A test agreement for event recovery.", clientId: userId, inviteToken: randomUUID(), status: "ACTIVE", termsVersion: 1 });
  await db!.insert(milestones).values({ id: milestoneId, dealId, idx: 1, title: "Test work", description: "", acceptanceCriteria: [{ criterion_id: "criterion-1", text: "A visible test result" }], amountCents: 10_000, currency: "USD", dueInDays: 7, workStatus: "SUBMITTED", authorizationStatus: "AUTHORIZED", captureStatus: "PENDING" });
  await db!.insert(paymentOperations).values({ id: operationId, operationType: "CAPTURE", milestoneId, actorUserId: userId, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), requestParameters: { amount_cents: 10_000, authorization_id: authorizationId, currency: "USD" }, status: "PENDING", providerObjectId: captureId });
  const fundingOperationId = randomUUID();
  await db!.insert(paymentOperations).values({ id: fundingOperationId, operationType: "CREATE_ORDER", milestoneId, actorUserId: userId, idempotencyKey: randomUUID(), requestFingerprint: randomUUID(), requestParameters: { amount_cents: 10_000, currency: "USD" }, status: "SUCCEEDED" });
  await db!.insert(paypalOrders).values({ id: orderId, operationId: fundingOperationId, milestoneId, createdBy: userId, amountCents: 10_000, currency: "USD", paypalOrderId: externalOrderId, status: "AUTHORIZED", authorizationId, authorizationStatus: "CREATED" });
  await db!.insert(captures).values({ id: captureId, operationId, milestoneId, paypalOrderRowId: orderId, authorizationId, amountCents: 10_000, finalCapture: true, releasedBy: userId, status: "PENDING", paypalCaptureId: captureId });
  await db!.insert(webhookEvents).values({ id: eventId, eventType: "PAYMENT.CAPTURE.COMPLETED", resourceType: "capture", resourceId: captureId, verified: true, payload: { id: eventId, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: captureId, status: "COMPLETED", supplementary_data: { related_ids: { authorization_id: authorizationId } } } } });
  t.after(async () => {
    await db!.delete(auditEvents).where(eq(auditEvents.dealId, dealId));
    await db!.delete(webhookEvents).where(eq(webhookEvents.id, eventId));
    await db!.delete(durableJobs).where(eq(durableJobs.resourceId, eventId));
    await db!.delete(captures).where(eq(captures.id, captureId));
    await db!.delete(paypalOrders).where(eq(paypalOrders.id, orderId));
    await db!.delete(paymentOperations).where(eq(paymentOperations.milestoneId, milestoneId));
    await db!.delete(milestones).where(eq(milestones.id, milestoneId));
    await db!.delete(deals).where(eq(deals.id, dealId));
    await db!.delete(users).where(eq(users.id, userId));
  });

  await processWebhook(eventId);
  await processWebhook(eventId);
  const [storedCapture] = await db!.select().from(captures).where(eq(captures.id, captureId));
  const [storedMilestone] = await db!.select().from(milestones).where(eq(milestones.id, milestoneId));
  const audits = await db!.select().from(auditEvents).where(and(eq(auditEvents.dealId, dealId), eq(auditEvents.eventType, "CAPTURE_COMPLETED")));
  assert.equal(storedCapture?.status, "COMPLETED");
  assert.equal(storedMilestone?.captureStatus, "COMPLETED");
  assert.equal(storedMilestone?.workStatus, "RELEASED");
  assert.equal(audits.length, 1);
});
