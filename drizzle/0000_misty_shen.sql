CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid,
	"milestone_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"agent_role" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"mode" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"stop_reason" text,
	"status" text NOT NULL,
	"error" text,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_daily_budget" (
	"budget_date" date PRIMARY KEY NOT NULL,
	"spent_micro_usd" numeric(20, 0) DEFAULT '0' NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"event_type" text NOT NULL,
	"deal_id" uuid,
	"milestone_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"amount_cents" integer,
	"currency" text,
	"paypal_ref" text,
	"note" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"paypal_order_row_id" uuid NOT NULL,
	"authorization_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"final_capture" boolean DEFAULT true NOT NULL,
	"paypal_capture_id" text,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"released_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captures_paypal_capture_id_unique" UNIQUE("paypal_capture_id")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"client_id" uuid NOT NULL,
	"freelancer_id" uuid,
	"demo_session_id" uuid,
	"invite_token" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"terms_version" integer DEFAULT 0 NOT NULL,
	"revision_rounds" integer DEFAULT 1 NOT NULL,
	"client_signed_version" integer,
	"freelancer_signed_version" integer,
	"client_signed_at" timestamp with time zone,
	"freelancer_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_status_check" CHECK ("deals"."status" in ('DRAFT','READY','NEGOTIATING','NEGOTIATION_FAILED','TERMS_PROPOSED','ACTIVE','COMPLETED','CANCELLED')),
	CONSTRAINT "deals_distinct_parties_check" CHECK ("deals"."freelancer_id" is null or "deals"."freelancer_id" <> "deals"."client_id")
);
--> statement-breakpoint
CREATE TABLE "durable_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"max_total_cents" integer,
	"deadline_days" integer,
	"min_total_cents" integer,
	"earliest_days" integer,
	"preferred_milestones" integer,
	"priorities" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_role_check" CHECK ("mandates"."role" in ('client', 'freelancer'))
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"due_in_days" integer NOT NULL,
	"work_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"authorization_status" text DEFAULT 'NONE' NOT NULL,
	"capture_status" text DEFAULT 'NONE' NOT NULL,
	"payout_status" text DEFAULT 'DISABLED' NOT NULL,
	"revisions_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_amount_positive_check" CHECK ("milestones"."amount_cents" >= 100)
);
--> statement-breakpoint
CREATE TABLE "negotiation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"seq" integer NOT NULL,
	"speaker" text NOT NULL,
	"action" text NOT NULL,
	"message" text NOT NULL,
	"terms" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_type" text NOT NULL,
	"milestone_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request_parameters" jsonb NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"provider_object_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"debug_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operations_type_check" CHECK ("payment_operations"."operation_type" in ('CREATE_ORDER','AUTHORIZE','CAPTURE','VOID','PAYOUT')),
	CONSTRAINT "payment_operations_status_check" CHECK ("payment_operations"."status" in ('REQUESTED','IN_PROGRESS','UNKNOWN','PENDING','SUCCEEDED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"sender_batch_id" text NOT NULL,
	"receiver_email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"payout_batch_id" text,
	"payout_item_id" text,
	"batch_status" text,
	"item_status" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_payout_batch_id_unique" UNIQUE("payout_batch_id")
);
--> statement-breakpoint
CREATE TABLE "paypal_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"paypal_order_id" text,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"authorization_id" text,
	"authorization_status" text,
	"authorization_expires_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_orders_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "paypal_orders_authorization_id_unique" UNIQUE("authorization_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"evidence_text" text NOT NULL,
	"evidence_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"canonical_terms" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"client_signed_at" timestamp with time zone,
	"freelancer_signed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"paypal_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"recommendation" text NOT NULL,
	"model_recommendation" text NOT NULL,
	"confidence" numeric(3, 2),
	"criteria_results" jsonb NOT NULL,
	"summary" text NOT NULL,
	"injection_suspected" boolean DEFAULT false NOT NULL,
	"agent_run_id" uuid,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"verified" boolean NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_paypal_order_row_id_paypal_orders_id_fk" FOREIGN KEY ("paypal_order_row_id") REFERENCES "public"."paypal_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_freelancer_id_users_id_fk" FOREIGN KEY ("freelancer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiation_turns" ADD CONSTRAINT "negotiation_turns_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_orders" ADD CONSTRAINT "paypal_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_snapshots" ADD CONSTRAINT "terms_snapshots_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_deal_created_idx" ON "agent_runs" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_deal_created_idx" ON "audit_events" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_category_created_idx" ON "audit_events" USING btree ("category","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "captures_one_active_per_milestone" ON "captures" USING btree ("milestone_id") WHERE "captures"."status" in ('REQUESTED','IN_PROGRESS','UNKNOWN','PENDING','COMPLETED');--> statement-breakpoint
CREATE UNIQUE INDEX "deals_invite_token_unique" ON "deals" USING btree ("invite_token");--> statement-breakpoint
CREATE INDEX "deals_client_idx" ON "deals" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "deals_freelancer_idx" ON "deals" USING btree ("freelancer_id");--> statement-breakpoint
CREATE INDEX "deals_demo_session_idx" ON "deals" USING btree ("demo_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "durable_jobs_one_active_resource" ON "durable_jobs" USING btree ("kind","resource_id") WHERE "durable_jobs"."status" in ('QUEUED','RUNNING','RETRY');--> statement-breakpoint
CREATE INDEX "durable_jobs_claim_idx" ON "durable_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_deal_role_unique" ON "mandates" USING btree ("deal_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_deal_idx_unique" ON "milestones" USING btree ("deal_id","idx");--> statement-breakpoint
CREATE INDEX "milestones_deal_work_idx" ON "milestones" USING btree ("deal_id","work_status");--> statement-breakpoint
CREATE UNIQUE INDEX "negotiation_turns_run_seq_unique" ON "negotiation_turns" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "negotiation_turns_deal_run_idx" ON "negotiation_turns" USING btree ("deal_id","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_idempotency_scope_unique" ON "payment_operations" USING btree ("operation_type","actor_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_operations_milestone_status_idx" ON "payment_operations" USING btree ("milestone_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_milestone_unique" ON "payouts" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_sender_batch_unique" ON "payouts" USING btree ("sender_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_orders_one_active_per_milestone" ON "paypal_orders" USING btree ("milestone_id") WHERE "paypal_orders"."status" in ('REQUESTED','IN_PROGRESS','UNKNOWN','CREATED','AUTHORIZED');--> statement-breakpoint
CREATE INDEX "paypal_orders_provider_idx" ON "paypal_orders" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE INDEX "submissions_milestone_created_idx" ON "submissions" USING btree ("milestone_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_snapshots_deal_version_unique" ON "terms_snapshots" USING btree ("deal_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "webhook_events_type_received_idx" ON "webhook_events" USING btree ("event_type","created_at");