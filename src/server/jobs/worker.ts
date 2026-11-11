import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { env } from "@/server/env";
import {
  auditEvents,
  captures,
  deals,
  durableJobs,
  milestones,
  paymentOperations,
  paypalOrders,
  webhookEvents,
} from "@/server/db/schema";
import {
  authorizeOrder,
  captureAuthorization,
  createAuthorizeOrder,
  getAuthorization,
  getCapture,
  getOrder,
  normalizeCaptureStatus,
  voidAuthorization,
} from "@/server/paypal/client";
import { logger } from "@/server/logger";

const WORKER_ID = `${process.env.HOSTNAME ?? "holdfast"}:${randomUUID()}`;
const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const ACTIVE_OPERATION_STATUSES = ["REQUESTED", "IN_PROGRESS", "UNKNOWN", "PENDING"] as const;

type WorkerStatusState = {
  enabled: boolean;
  workerId: string | null;
  lastTickAt: string | null;
  lastError: string | null;
};

type WorkerGlobal = typeof globalThis & {
  __holdfastDurableWorkerStatus?: WorkerStatusState;
};

// Next.js bundles instrumentation and route handlers separately. Store status on
// globalThis so the health route can observe the worker started by instrumentation.
const workerStatus = ((globalThis as WorkerGlobal).__holdfastDurableWorkerStatus ??= {
  enabled: false,
  workerId: null,
  lastTickAt: null,
  lastError: null,
});

export function retryDelayMs(attempt: number) {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(0, attempt), 10));
}

type Job = typeof durableJobs.$inferSelect;

export async function claimJob() {
  const db = getDatabase();
  if (!db) return null;
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.update(durableJobs)
      .set({ status: "RETRY", leaseOwner: null, leaseExpiresAt: null, runAfter: now, updatedAt: now, lastError: "Worker lease expired; job recovered." })
      .where(and(eq(durableJobs.status, "RUNNING"), lte(durableJobs.leaseExpiresAt, now)));

    const [job] = await tx.select().from(durableJobs)
      .where(and(inArray(durableJobs.status, ["QUEUED", "RETRY"]), lte(durableJobs.runAfter, now)))
      .orderBy(durableJobs.runAfter, durableJobs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    const [claimed] = await tx.update(durableJobs).set({
      status: "RUNNING",
      leaseOwner: WORKER_ID,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      heartbeatAt: now,
      attempts: job.attempts + 1,
      updatedAt: now,
    }).where(eq(durableJobs.id, job.id)).returning();
    return claimed ?? null;
  });
}

export async function renewJobLease(jobId: string, workerId = WORKER_ID, now = new Date()) {
  const db = getDatabase();
  if (!db) return false;
  const [renewed] = await db.update(durableJobs).set({
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    heartbeatAt: now,
    updatedAt: now,
  }).where(and(
    eq(durableJobs.id, jobId),
    eq(durableJobs.status, "RUNNING"),
    eq(durableJobs.leaseOwner, workerId),
  )).returning({ id: durableJobs.id });
  return Boolean(renewed);
}

async function withLeaseHeartbeat(job: Job, work: () => Promise<void>) {
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void renewJobLease(job.id).catch((error: unknown) => {
      logger.warn({ jobId: job.id, error }, "Could not renew durable job lease");
    }).finally(() => { heartbeatRunning = false; });
  }, Math.floor(LEASE_MS / 3));
  timer.unref();
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
}

async function completeJob(job: Job) {
  const db = getDatabase();
  if (!db) return;
  await db.update(durableJobs).set({ status: "DONE", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(durableJobs.id, job.id), eq(durableJobs.leaseOwner, WORKER_ID)));
}

async function retryJob(job: Job, error: unknown) {
  const db = getDatabase();
  if (!db) return;
  const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown worker error.";
  const exhausted = job.attempts >= job.maxAttempts;
  const delay = retryDelayMs(job.attempts);
  const status = exhausted ? "FAILED" : "RETRY";
  await db.update(durableJobs).set({
    status,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: new Date(),
    runAfter: new Date(Date.now() + delay),
    lastError: message,
    updatedAt: new Date(),
  }).where(and(eq(durableJobs.id, job.id), eq(durableJobs.leaseOwner, WORKER_ID)));
  if (job.kind === "PAYPAL_WEBHOOK") {
    await db.update(webhookEvents).set({ processingError: message }).where(eq(webhookEvents.id, job.resourceId));
  }
  if (exhausted) logger.error({ jobId: job.id, kind: job.kind, resourceId: job.resourceId, error: message }, "Durable job exhausted retries");
}

function getString(value: unknown) {
  return typeof value === "string" ? value : null;
}

async function enqueueRecovery(operationId: string) {
  const db = getDatabase();
  if (!db) return;
  const [failed] = await db.select({ id: durableJobs.id }).from(durableJobs).where(and(eq(durableJobs.kind, "PAYMENT_RECOVERY"), eq(durableJobs.resourceId, operationId), eq(durableJobs.status, "FAILED"))).limit(1);
  if (!failed) await db.insert(durableJobs).values({ kind: "PAYMENT_RECOVERY", resourceId: operationId, status: "QUEUED" }).onConflictDoNothing();
}

export async function recoverPaymentOperation(operationId: string, createOrder = createAuthorizeOrder) {
  const db = getDatabase();
  if (!db) return;
  const [row] = await db.select({ operation: paymentOperations, order: paypalOrders, capture: captures, milestone: milestones, deal: deals })
    .from(paymentOperations)
    .innerJoin(milestones, eq(paymentOperations.milestoneId, milestones.id))
    .innerJoin(deals, eq(milestones.dealId, deals.id))
    .leftJoin(paypalOrders, eq(paypalOrders.operationId, paymentOperations.id))
    .leftJoin(captures, eq(captures.operationId, paymentOperations.id))
    .where(eq(paymentOperations.id, operationId)).limit(1);
  if (!row || !ACTIVE_OPERATION_STATUSES.includes(row.operation.status as typeof ACTIVE_OPERATION_STATUSES[number])) return;
  const params = row.operation.requestParameters;
  const now = new Date();

  if (row.operation.operationType === "CREATE_ORDER") {
    const amountCents = Number(params.amount_cents);
    const currency = getString(params.currency);
    const returnUrl = getString(params.return_url);
    const cancelUrl = getString(params.cancel_url);
    if (!Number.isInteger(amountCents) || !currency || !returnUrl || !cancelUrl) throw new Error("Order operation is missing its immutable parameters.");
    const result = await createOrder({ milestoneId: row.milestone.id, amountCents, currency, returnUrl, cancelUrl, requestId: row.operation.id });
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: "SUCCEEDED", providerObjectId: result.id, attemptCount: row.operation.attemptCount + 1, updatedAt: now }).where(eq(paymentOperations.id, operationId));
      await tx.update(paypalOrders).set({ paypalOrderId: result.id, status: "CREATED", failureReason: null, updatedAt: now }).where(eq(paypalOrders.operationId, operationId));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "ORDER_RECOVERED", dealId: row.deal.id, milestoneId: row.milestone.id, actorType: "SYSTEM", amountCents, currency, paypalRef: result.id, data: { operation_id: operationId } });
    });
    return;
  }

  if (row.operation.operationType === "AUTHORIZE") {
    const orderId = getString(params.paypal_order_id);
    if (!orderId || !row.order) throw new Error("Authorization operation is missing its order reference.");
    const order = await getOrder(orderId);
    let authorization = order.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
    if (!authorization?.id && order.status === "APPROVED") {
      const authorized = await authorizeOrder(orderId, row.operation.id);
      authorization = authorized.purchase_units?.flatMap((unit) => unit.payments?.authorizations ?? [])[0];
    }
    if (!authorization?.id) throw new Error(`PayPal order is ${order.status}; authorization is not yet confirmed.`);
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: "SUCCEEDED", providerObjectId: authorization!.id, attemptCount: row.operation.attemptCount + 1, updatedAt: now }).where(eq(paymentOperations.id, operationId));
      await tx.update(paypalOrders).set({ status: "AUTHORIZED", authorizationId: authorization!.id, authorizationStatus: authorization!.status, updatedAt: now }).where(eq(paypalOrders.id, row.order!.id));
      await tx.update(milestones).set({ authorizationStatus: "AUTHORIZED", updatedAt: now }).where(eq(milestones.id, row.milestone.id));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_RECOVERED", dealId: row.deal.id, milestoneId: row.milestone.id, actorType: "SYSTEM", actorUserId: row.operation.actorUserId, amountCents: row.order!.amountCents, currency: row.order!.currency, paypalRef: authorization!.id, data: { operation_id: operationId, paypal_order_id: orderId } });
    });
    return;
  }

  if (row.operation.operationType === "CAPTURE") {
    const authorizationId = getString(params.authorization_id);
    const amountCents = Number(params.amount_cents);
    const currency = getString(params.currency) ?? row.order?.currency ?? row.milestone.currency;
    if (!authorizationId || !Number.isInteger(amountCents) || !row.capture || !row.order) throw new Error("Capture operation is missing its immutable parameters.");
    const auth = await getAuthorization(authorizationId);
    const providerAmount = auth.amount;
    if (providerAmount && (providerAmount.currency_code !== currency || Number(providerAmount.value) !== amountCents / 100)) throw new Error("PayPal authorization amount differs from the stored capture request.");
    if (auth.status !== "CREATED" && auth.status !== "CAPTURED") throw new Error(`PayPal authorization is ${auth.status}; capture outcome needs provider confirmation.`);
    // A retry uses the original UUID. If the capture ID is known, read its status first.
    const result = row.operation.providerObjectId
      ? await getCapture(row.operation.providerObjectId)
      : await captureAuthorization({ authorizationId, amountCents, currency, requestId: row.operation.id, invoiceId: `milestone-${row.milestone.id}` });
    if (!result.id) throw new Error("PayPal capture response did not contain an ID.");
    const captureStatus = normalizeCaptureStatus(result.status);
    const completed = captureStatus === "COMPLETED";
    const operationStatus = captureStatus === "COMPLETED" ? "SUCCEEDED" : captureStatus === "PENDING" ? "PENDING" : captureStatus === "FAILED" ? "FAILED" : "UNKNOWN";
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: operationStatus, providerObjectId: result.id, attemptCount: row.operation.attemptCount + 1, updatedAt: now }).where(eq(paymentOperations.id, operationId));
      await tx.update(captures).set({ status: captureStatus, paypalCaptureId: result.id, updatedAt: now }).where(eq(captures.operationId, operationId));
      await tx.update(milestones).set({ captureStatus, ...(completed ? { workStatus: "RELEASED" } : {}), updatedAt: now }).where(eq(milestones.id, row.milestone.id));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: completed ? "CAPTURE_RECOVERED" : `CAPTURE_${captureStatus}`, dealId: row.deal.id, milestoneId: row.milestone.id, actorType: "SYSTEM", amountCents, currency, paypalRef: result.id, data: { operation_id: operationId, provider_status: result.status } });
    });
    return;
  }

  if (row.operation.operationType === "VOID") {
    const authorizationId = getString(params.authorization_id);
    if (!authorizationId || !row.order) throw new Error("Void operation is missing its authorization reference.");
    const auth = await getAuthorization(authorizationId);
    if (auth.status === "CREATED") await voidAuthorization(authorizationId, row.operation.id);
    else if (auth.status !== "VOIDED") throw new Error(`PayPal authorization is ${auth.status}; void outcome needs provider confirmation.`);
    await db.transaction(async (tx) => {
      await tx.update(paymentOperations).set({ status: "SUCCEEDED", attemptCount: row.operation.attemptCount + 1, updatedAt: now }).where(eq(paymentOperations.id, operationId));
      await tx.update(paypalOrders).set({ authorizationStatus: "VOIDED", status: "VOIDED", updatedAt: now }).where(eq(paypalOrders.id, row.order!.id));
      await tx.update(milestones).set({ authorizationStatus: "VOIDED", workStatus: "CANCELLED", updatedAt: now }).where(eq(milestones.id, row.milestone.id));
      const [remaining] = await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.dealId, row.deal.id), ne(milestones.workStatus, "CANCELLED"))).limit(1);
      if (!remaining) await tx.update(deals).set({ status: "CANCELLED", updatedAt: now }).where(eq(deals.id, row.deal.id));
      await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: "AUTHORIZATION_VOID_RECOVERED", dealId: row.deal.id, milestoneId: row.milestone.id, actorType: "SYSTEM", actorUserId: row.operation.actorUserId, currency: row.milestone.currency, paypalRef: authorizationId, data: { operation_id: operationId } });
    });
  }
}

export async function processWebhook(eventId: string) {
  const db = getDatabase();
  if (!db) throw new Error("Database is not configured.");
  const [eventRow] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId)).limit(1);
  if (!eventRow || !eventRow.verified || !eventRow.payload) throw new Error("Verified webhook event is unavailable.");
  if (eventRow.processedAt) return;
  const payload = eventRow.payload as Record<string, unknown>;
  const resource = typeof payload.resource === "object" && payload.resource !== null ? payload.resource as Record<string, unknown> : {};
  const resourceId = getString(resource.id) ?? eventRow.resourceId;
  const related = typeof resource.supplementary_data === "object" && resource.supplementary_data !== null
    ? (resource.supplementary_data as { related_ids?: Record<string, unknown> }).related_ids ?? {}
    : {};
  const authorizationId = getString(related.authorization_id) ?? (eventRow.eventType.startsWith("PAYMENT.AUTHORIZATION.") ? resourceId : null);
  const now = new Date();
  let markedProcessed = false;

  if (eventRow.eventType === "CHECKOUT.ORDER.APPROVED") {
    const orderId = resourceId;
    if (!orderId) throw new Error("Approved order event has no provider order ID.");
    const [orderRow] = await db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, orderId)).limit(1);
    if (!orderRow) throw new Error("Approved order is not linked to a local funding attempt yet.");
    const providerOrder = await getOrder(orderId);
    const purchaseUnit = providerOrder.purchase_units?.[0];
    if (providerOrder.status !== "APPROVED" || purchaseUnit?.reference_id !== orderRow.milestoneId || !purchaseUnit.amount || purchaseUnit.amount.currency_code !== orderRow.currency || Number(purchaseUnit.amount.value) !== orderRow.amountCents / 100) {
      throw new Error("Approved PayPal order did not match the stored milestone amount and reference.");
    }
    await db.transaction(async (tx) => {
      await tx.select().from(paypalOrders).where(eq(paypalOrders.id, orderRow.id)).for("update").limit(1);
      const key = `authorize:${orderRow.operationId}`;
      const fingerprint = `${orderId}:${orderRow.milestoneId}:${orderRow.amountCents}:${orderRow.currency}`;
      const [existing] = await tx.select().from(paymentOperations).where(and(eq(paymentOperations.operationType, "AUTHORIZE"), eq(paymentOperations.actorUserId, orderRow.createdBy), eq(paymentOperations.idempotencyKey, key))).for("update").limit(1);
      if (existing && (existing.requestFingerprint !== fingerprint || existing.milestoneId !== orderRow.milestoneId)) throw new Error("Existing authorization operation does not match this approved order.");
      const operation = existing ?? (await tx.insert(paymentOperations).values({
        id: randomUUID(), operationType: "AUTHORIZE", milestoneId: orderRow.milestoneId, actorUserId: orderRow.createdBy,
        idempotencyKey: key, requestFingerprint: fingerprint, requestParameters: { paypal_order_id: orderId }, status: "IN_PROGRESS",
      }).returning())[0];
      if (!operation) throw new Error("Authorization operation could not be created.");
      if (!["SUCCEEDED", "FAILED"].includes(operation.status)) await tx.insert(durableJobs).values({ kind: "PAYMENT_RECOVERY", resourceId: operation.id, status: "QUEUED" }).onConflictDoNothing();
      await tx.update(webhookEvents).set({ processedAt: now, processingError: null }).where(eq(webhookEvents.id, eventId));
    });
    markedProcessed = true;
  } else if (eventRow.eventType === "PAYMENT.AUTHORIZATION.CREATED" || eventRow.eventType === "PAYMENT.AUTHORIZATION.VOIDED" || eventRow.eventType === "PAYMENT.AUTHORIZATION.EXPIRED") {
    if (!authorizationId) throw new Error("Authorization event has no provider authorization ID.");
    const orderId = getString(related.order_id);
    let [orderRow] = await db.select().from(paypalOrders).where(eq(paypalOrders.authorizationId, authorizationId)).limit(1);
    if (!orderRow && orderId) [orderRow] = await db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, orderId)).limit(1);
    if (!orderRow) throw new Error("Authorization event is not linked to a local funding attempt yet.");
    const terminal = eventRow.eventType.endsWith("VOIDED") ? "VOIDED" : eventRow.eventType.endsWith("EXPIRED") ? "EXPIRED" : null;
    await db.transaction(async (tx) => {
      const [milestone] = await tx.select().from(milestones).where(eq(milestones.id, orderRow.milestoneId)).for("update").limit(1);
      if (terminal && milestone && milestone.captureStatus === "NONE") {
        await tx.update(paypalOrders).set({ authorizationId, authorizationStatus: terminal, status: terminal, updatedAt: now }).where(eq(paypalOrders.id, orderRow.id));
        await tx.update(milestones).set({ authorizationStatus: terminal, updatedAt: now }).where(eq(milestones.id, orderRow.milestoneId));
        await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: `AUTHORIZATION_${terminal}`, dealId: (await tx.select({ dealId: milestones.dealId }).from(milestones).where(eq(milestones.id, orderRow.milestoneId)).limit(1))[0]?.dealId, milestoneId: orderRow.milestoneId, actorType: "SYSTEM", amountCents: orderRow.amountCents, currency: orderRow.currency, paypalRef: authorizationId, data: { webhook_event_id: eventId } });
      } else if (!terminal) {
        await tx.update(paypalOrders).set({ authorizationId, authorizationStatus: "AUTHORIZED", status: "AUTHORIZED", updatedAt: now }).where(eq(paypalOrders.id, orderRow.id));
        await tx.update(milestones).set({ authorizationStatus: "AUTHORIZED", updatedAt: now }).where(eq(milestones.id, orderRow.milestoneId));
      }
      await tx.update(webhookEvents).set({ processedAt: now, processingError: null }).where(eq(webhookEvents.id, eventId));
    });
    markedProcessed = true;
  } else if (eventRow.eventType.startsWith("PAYMENT.CAPTURE.")) {
    const captureId = resourceId;
    const [captureRow] = captureId ? await db.select().from(captures).where(eq(captures.paypalCaptureId, captureId)).limit(1) : [];
    let target = captureRow;
    if (!target && authorizationId) [target] = await db.select().from(captures).where(eq(captures.authorizationId, authorizationId)).limit(1);
    if (!target) throw new Error("Capture event is not linked to a local capture operation yet.");
    const [base] = await db.select({ milestone: milestones, deal: deals, operation: paymentOperations }).from(captures)
      .innerJoin(milestones, eq(captures.milestoneId, milestones.id)).innerJoin(deals, eq(milestones.dealId, deals.id))
      .innerJoin(paymentOperations, eq(captures.operationId, paymentOperations.id)).where(eq(captures.id, target.id)).limit(1);
    if (!base) throw new Error("Capture operation was removed before its event was processed.");
    const status = getString(resource.status)?.toUpperCase() ?? eventRow.eventType.split(".").at(-1);
    const completed = status === "COMPLETED" || eventRow.eventType === "PAYMENT.CAPTURE.COMPLETED";
    const pending = status === "PENDING" || eventRow.eventType === "PAYMENT.CAPTURE.PENDING";
    const normalized = completed ? "COMPLETED" : pending ? "PENDING" : "FAILED";
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(captures).where(eq(captures.id, target.id)).for("update").limit(1);
      if (current && current.status !== "COMPLETED") {
        await tx.update(captures).set({ status: normalized, ...(captureId ? { paypalCaptureId: captureId } : {}), updatedAt: now }).where(eq(captures.id, target.id));
        await tx.update(paymentOperations).set({ status: completed ? "SUCCEEDED" : pending ? "PENDING" : "FAILED", ...(captureId ? { providerObjectId: captureId } : {}), updatedAt: now }).where(eq(paymentOperations.id, base.operation.id));
        await tx.update(milestones).set({ captureStatus: normalized, ...(completed ? { workStatus: "RELEASED" } : {}), updatedAt: now }).where(eq(milestones.id, base.milestone.id));
        await tx.insert(auditEvents).values({ category: "PAYMENT", eventType: `CAPTURE_${normalized}`, dealId: base.deal.id, milestoneId: base.milestone.id, actorType: "SYSTEM", amountCents: target.amountCents, currency: base.milestone.currency, paypalRef: captureId ?? undefined, data: { webhook_event_id: eventId } });
      }
      await tx.update(webhookEvents).set({ processedAt: now, processingError: null }).where(eq(webhookEvents.id, eventId));
    });
    markedProcessed = true;
  }

  if (!markedProcessed) await db.update(webhookEvents).set({ processedAt: now, processingError: null }).where(eq(webhookEvents.id, eventId));
}

async function recoverStaleOperations() {
  const db = getDatabase();
  if (!db) return;
  const staleBefore = new Date(Date.now() - LEASE_MS);
  const rows = await db.select({ id: paymentOperations.id }).from(paymentOperations)
    .where(and(inArray(paymentOperations.status, [...ACTIVE_OPERATION_STATUSES]), lte(paymentOperations.updatedAt, staleBefore)))
    .limit(100);
  for (const row of rows) await enqueueRecovery(row.id);
  const unprocessed = await db.select({ id: webhookEvents.id }).from(webhookEvents)
    .where(and(eq(webhookEvents.verified, true), isNull(webhookEvents.processedAt))).limit(100);
  for (const row of unprocessed) {
    const [failed] = await db.select({ id: durableJobs.id }).from(durableJobs).where(and(eq(durableJobs.kind, "PAYPAL_WEBHOOK"), eq(durableJobs.resourceId, row.id), eq(durableJobs.status, "FAILED"))).limit(1);
    if (!failed) await db.insert(durableJobs).values({ kind: "PAYPAL_WEBHOOK", resourceId: row.id, status: "QUEUED" }).onConflictDoNothing();
  }
}

export function getWorkerStatus() {
  return {
    enabled: workerStatus.enabled,
    worker_id: workerStatus.workerId,
    last_tick_at: workerStatus.lastTickAt,
    last_error: workerStatus.lastError,
  };
}

export function startDurableWorker() {
  if (workerStatus.enabled || env.WORKER_DISABLED) return;
  workerStatus.enabled = true;
  workerStatus.workerId = WORKER_ID;
  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    workerStatus.lastTickAt = new Date().toISOString();
    try {
      await recoverStaleOperations();
      for (let i = 0; i < 8; i += 1) {
        const job = await claimJob();
        if (!job) break;
        try {
          await withLeaseHeartbeat(job, async () => {
            if (job.kind === "PAYPAL_WEBHOOK") await processWebhook(job.resourceId);
            else if (job.kind === "PAYMENT_RECOVERY") await recoverPaymentOperation(job.resourceId);
            else throw new Error(`Unknown durable job kind: ${job.kind}`);
          });
          await completeJob(job);
        } catch (error) {
          logger.warn({ jobId: job.id, kind: job.kind, error }, "Durable job will be retried");
          await retryJob(job, error);
        }
      }
      workerStatus.lastError = null;
    } catch (error) {
      workerStatus.lastError = error instanceof Error ? error.message : "Worker tick failed.";
      logger.error({ error }, "Durable worker tick failed");
    } finally {
      tickRunning = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 5_000);
  timer.unref();
}

export async function retryFailedJob(jobId: string) {
  const db = getDatabase();
  if (!db) throw new Error("Database is not configured.");
  const [job] = await db.update(durableJobs).set({ status: "QUEUED", attempts: 0, runAfter: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(durableJobs.id, jobId), eq(durableJobs.status, "FAILED"))).returning();
  if (!job) throw new Error("Failed job not found.");
  return job;
}
