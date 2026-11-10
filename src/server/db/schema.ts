import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("user"),
  paypalEmail: text("paypal_email"),
  createdAt: now(),
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
  check("users_role_check", sql`${table.role} in ('user', 'admin')`),
]);

export const deals = pgTable("deals", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  clientId: uuid("client_id").notNull().references(() => users.id),
  freelancerId: uuid("freelancer_id").references(() => users.id),
  demoSessionId: uuid("demo_session_id"),
  inviteToken: text("invite_token").notNull(),
  status: text("status").notNull().default("DRAFT"),
  currency: text("currency").notNull().default("USD"),
  termsVersion: integer("terms_version").notNull().default(0),
  revisionRounds: integer("revision_rounds").notNull().default(1),
  clientSignedVersion: integer("client_signed_version"),
  freelancerSignedVersion: integer("freelancer_signed_version"),
  clientSignedAt: timestamp("client_signed_at", { withTimezone: true }),
  freelancerSignedAt: timestamp("freelancer_signed_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("deals_invite_token_unique").on(table.inviteToken),
  index("deals_client_idx").on(table.clientId),
  index("deals_freelancer_idx").on(table.freelancerId),
  index("deals_demo_session_idx").on(table.demoSessionId),
  check("deals_status_check", sql`${table.status} in ('DRAFT','READY','NEGOTIATING','NEGOTIATION_FAILED','TERMS_PROPOSED','ACTIVE','COMPLETED','CANCELLED')`),
  check("deals_distinct_parties_check", sql`${table.freelancerId} is null or ${table.freelancerId} <> ${table.clientId}`),
]);

export const mandates = pgTable("mandates", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  maxTotalCents: integer("max_total_cents"),
  deadlineDays: integer("deadline_days"),
  minTotalCents: integer("min_total_cents"),
  earliestDays: integer("earliest_days"),
  preferredMilestones: integer("preferred_milestones"),
  priorities: text("priorities").notNull().default(""),
  createdAt: now(),
}, (table) => [
  uniqueIndex("mandates_deal_role_unique").on(table.dealId, table.role),
  check("mandates_role_check", sql`${table.role} in ('client', 'freelancer')`),
]);

export const termsSnapshots = pgTable("terms_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  canonicalTerms: jsonb("canonical_terms").notNull().$type<Record<string, unknown>>(),
  fingerprint: text("fingerprint").notNull(),
  clientSignedAt: timestamp("client_signed_at", { withTimezone: true }),
  freelancerSignedAt: timestamp("freelancer_signed_at", { withTimezone: true }),
  createdAt: now(),
}, (table) => [uniqueIndex("terms_snapshots_deal_version_unique").on(table.dealId, table.version)]);

export const negotiationTurns = pgTable("negotiation_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull(),
  runNumber: integer("run_number").notNull(),
  seq: integer("seq").notNull(),
  speaker: text("speaker").notNull(),
  action: text("action").notNull(),
  message: text("message").notNull(),
  terms: jsonb("terms").$type<Record<string, unknown> | null>(),
  createdAt: now(),
}, (table) => [
  uniqueIndex("negotiation_turns_run_seq_unique").on(table.runId, table.seq),
  index("negotiation_turns_deal_run_idx").on(table.dealId, table.runNumber),
]);

export const milestones = pgTable("milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  acceptanceCriteria: jsonb("acceptance_criteria").notNull().$type<Array<{ criterion_id: string; text: string }>>(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("USD"),
  dueInDays: integer("due_in_days").notNull(),
  workStatus: text("work_status").notNull().default("NOT_STARTED"),
  authorizationStatus: text("authorization_status").notNull().default("NONE"),
  captureStatus: text("capture_status").notNull().default("NONE"),
  payoutStatus: text("payout_status").notNull().default("DISABLED"),
  revisionsUsed: integer("revisions_used").notNull().default(0),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("milestones_deal_idx_unique").on(table.dealId, table.idx),
  index("milestones_deal_work_idx").on(table.dealId, table.workStatus),
  check("milestones_amount_positive_check", sql`${table.amountCents} >= 100`),
]);

export const paymentOperations = pgTable("payment_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationType: text("operation_type").notNull(),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  requestParameters: jsonb("request_parameters").notNull().$type<Record<string, unknown>>(),
  status: text("status").notNull().default("REQUESTED"),
  providerObjectId: text("provider_object_id"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  debugId: text("debug_id"),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("payment_operations_idempotency_scope_unique").on(table.operationType, table.actorUserId, table.idempotencyKey),
  index("payment_operations_milestone_status_idx").on(table.milestoneId, table.status),
  check("payment_operations_type_check", sql`${table.operationType} in ('CREATE_ORDER','AUTHORIZE','CAPTURE','VOID','PAYOUT')`),
  check("payment_operations_status_check", sql`${table.status} in ('REQUESTED','IN_PROGRESS','UNKNOWN','PENDING','SUCCEEDED','FAILED')`),
]);

export const paypalOrders = pgTable("paypal_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => paymentOperations.id),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  paypalOrderId: text("paypal_order_id").unique(),
  status: text("status").notNull().default("REQUESTED"),
  authorizationId: text("authorization_id").unique(),
  authorizationStatus: text("authorization_status"),
  authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("paypal_orders_one_active_per_milestone").on(table.milestoneId).where(sql`${table.status} in ('REQUESTED','IN_PROGRESS','UNKNOWN','CREATED','AUTHORIZED')`),
  index("paypal_orders_provider_idx").on(table.paypalOrderId),
]);

export const captures = pgTable("captures", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => paymentOperations.id),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  paypalOrderRowId: uuid("paypal_order_row_id").notNull().references(() => paypalOrders.id),
  authorizationId: text("authorization_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  finalCapture: boolean("final_capture").notNull().default(true),
  paypalCaptureId: text("paypal_capture_id").unique(),
  status: text("status").notNull().default("REQUESTED"),
  releasedBy: uuid("released_by").notNull().references(() => users.id),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("captures_one_active_per_milestone").on(table.milestoneId).where(sql`${table.status} in ('REQUESTED','IN_PROGRESS','UNKNOWN','PENDING','COMPLETED')`),
]);

export const payouts = pgTable("payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => paymentOperations.id),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  senderBatchId: text("sender_batch_id").notNull(),
  receiverEmail: text("receiver_email").notNull(),
  amountCents: integer("amount_cents").notNull(),
  payoutBatchId: text("payout_batch_id").unique(),
  payoutItemId: text("payout_item_id"),
  batchStatus: text("batch_status"),
  itemStatus: text("item_status"),
  error: text("error"),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("payouts_milestone_unique").on(table.milestoneId),
  uniqueIndex("payouts_sender_batch_unique").on(table.senderBatchId),
]);

export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  milestoneId: uuid("milestone_id").notNull().references(() => milestones.id),
  submittedBy: uuid("submitted_by").notNull().references(() => users.id),
  evidenceText: text("evidence_text").notNull(),
  evidenceUrl: text("evidence_url"),
  createdAt: now(),
}, (table) => [index("submissions_milestone_created_idx").on(table.milestoneId, table.createdAt)]);

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  recommendation: text("recommendation").notNull(),
  modelRecommendation: text("model_recommendation").notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }),
  criteriaResults: jsonb("criteria_results").notNull().$type<Array<Record<string, unknown>>>(),
  summary: text("summary").notNull(),
  injectionSuspected: boolean("injection_suspected").notNull().default(false),
  agentRunId: uuid("agent_run_id"),
  promptVersion: text("prompt_version").notNull(),
  createdAt: now(),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").references(() => deals.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  runId: uuid("run_id"),
  kind: text("kind").notNull(),
  agentRole: text("agent_role"),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  mode: text("mode").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  stopReason: text("stop_reason"),
  status: text("status").notNull(),
  error: text("error"),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  createdAt: now(),
}, (table) => [index("agent_runs_deal_created_idx").on(table.dealId, table.createdAt)]);

export const aiDailyBudget = pgTable("ai_daily_budget", {
  budgetDate: date("budget_date", { mode: "string" }).primaryKey(),
  spentMicroUsd: numeric("spent_micro_usd", { precision: 20, scale: 0 }).notNull().default("0"),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: updated(),
});

export const durableJobs = pgTable("durable_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
  status: text("status").notNull().default("QUEUED"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(8),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: now(),
  updatedAt: updated(),
}, (table) => [
  uniqueIndex("durable_jobs_one_active_resource").on(table.kind, table.resourceId).where(sql`${table.status} in ('QUEUED','RUNNING','RETRY')`),
  index("durable_jobs_claim_idx").on(table.status, table.runAfter),
]);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  verified: boolean("verified").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown> | null>(),
  receivedAt: now(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingError: text("processing_error"),
}, (table) => [index("webhook_events_type_received_idx").on(table.eventType, table.receivedAt)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: now(),
  category: text("category").notNull(),
  eventType: text("event_type").notNull(),
  dealId: uuid("deal_id").references(() => deals.id),
  milestoneId: uuid("milestone_id").references(() => milestones.id),
  actorType: text("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  amountCents: integer("amount_cents"),
  currency: text("currency"),
  paypalRef: text("paypal_ref"),
  note: text("note"),
  data: jsonb("data").$type<Record<string, unknown> | null>(),
}, (table) => [
  index("audit_events_deal_created_idx").on(table.dealId, table.createdAt),
  index("audit_events_category_created_idx").on(table.category, table.createdAt),
]);
