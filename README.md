# HoldFast

**Agents help shape the deal. PayPal authorizes the milestone. People decide what happens next.**

HoldFast is a sandbox-only hackathon prototype for service agreements. People can create and join an agreement, negotiate terms with isolated AI context or deterministic replay, sign an immutable version, authorize a milestone through PayPal sandbox, submit evidence, and explicitly request a full capture. Replay verification is intentionally marked unclear; live verification is advisory and the client remains responsible for the release decision.

## Implemented

- Responsive public landing page and authenticated workspace shell.
- Email/password registration and login, signed HTTP-only sessions, logout, demo persona login, and server-side membership checks for agreement reads.
- PostgreSQL schema and initial Drizzle migration for agreements, private mandates, signed terms snapshots, independent work/authorization/capture/payout states, payment operations, webhooks, jobs, AI runs, and audit events.
- The seed script creates the local admin identity. Demo client/freelancer users and their signed Bakery sample agreement are created in a browser-scoped demo session, so separate visitors do not share agreements.
- PayPal client is locked to `api-m.sandbox.paypal.com`. It supports OAuth, authorize-intent order creation, order lookup, authorization, capture, and void. Payment mutation calls require a plain UUID idempotency key.
- Payment operations persist immutable parameters and a stable PayPal request UUID. Uncertain orders, authorizations, captures, and voids are retried by the PostgreSQL-backed worker; webhook events are verified, queued, and processed idempotently.
- Signed terms, private freelancer mandates, editable versioned terms before work/payment starts, milestone authorization, HTTPS evidence submission, explicit client capture, PayPal return/cancel handling, and webhook signature verification.
- Mandate-checked agent negotiation with a spend ceiling, replay mode, immutable term snapshots, strict allowlisted evidence retrieval, criterion-bound advisory verification, revision requests, eligible authorization voids, and a party-scoped audit ledger.
- The workspace and `/demo/deliverable` provide the walkthrough screens. `/ledger` has sortable/filterable audit history and CSV export. `/admin/jobs` provides protected worker job inspection and retry for admins.
- Health reports database connectivity and worker status. No real PayPal payment is made by the seed data. Payouts remain disabled.

## Local setup

Requirements: Node.js 20.9 or newer and PostgreSQL 14 or newer.

```powershell
Copy-Item .env.example .env
# Set DATABASE_URL and a unique SESSION_SECRET of at least 32 characters in .env
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. In demo mode, the client and freelancer buttons create browser-isolated Maya and Arjun accounts with a sample agreement on first use. The admin persona is available for local job-queue review. Demo fixtures do not create a PayPal order or authorization.

For registration and sign-in only, the app can start without a database, but authenticated pages and demo accounts require PostgreSQL. Database migrations are generated into `drizzle/` and applied with `npm run db:migrate`.

## Environment

Start from `.env.example`. Set `SESSION_SECRET` to a unique value of at least 32 characters. PayPal credentials must belong to a sandbox app; the application rejects any host other than `api-m.sandbox.paypal.com`, including in production. Configure `APP_URL` to the exact public origin used for PayPal return URLs. Set the PayPal webhook ID and register `/api/webhooks/paypal` with the PayPal sandbox app. `WORKER_DISABLED=false` starts the durable worker in the Node server process.

`PAYOUTS_ENABLED` defaults to false and this version does not pay the freelancer. AI is in replay mode by default. Replay negotiation uses fixed sample agent messages; replay verification returns `unclear` and does not inspect a URL. Live evidence review requires an allowed public HTTPS host: set `EVIDENCE_ALLOWED_HOSTS` to a comma-separated list of exact hostnames (no scheme or path). The `APP_URL` hostname is also allowed. The fetcher rejects redirects, private or reserved IPs, non-HTTPS URLs, and oversized/slow responses. Live AI requires `ANTHROPIC_API_KEY`, respects the daily spend ceiling, and uses configurable token prices.

The seed script creates the `admin@holdfast.demo` account with the admin role. In local demo mode, use the `Demo admin` persona to inspect jobs. For another admin, either provision the database user with the `admin` role or set `ADMIN_EMAILS` to a comma-separated allowlist of email addresses. Admin users can inspect failed jobs at `/admin/jobs`; the corresponding protected API is `GET` and `POST /api/v1/admin/jobs`. Demo persona controls are hidden when `DEMO_MODE=false`.

Run `npm run smoke:paypal` to check OAuth connectivity without creating an order or payment.

## API currently available

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | App health and optional database round-trip |
| `POST` | `/api/v1/auth/register` | Create a user account |
| `POST` | `/api/v1/auth/login` | Start a user session |
| `POST` | `/api/v1/auth/logout` | End the current session |
| `POST` | `/api/v1/auth/demo` | Sign in as a seeded demo persona |
| `GET` | `/api/v1/me` | Current authenticated user |
| `GET` | `/api/v1/deals` | Agreements for the current user and their milestones |
| `POST` | `/api/v1/deals` | Create a draft agreement, milestones, and private invitation |
| `GET` | `/api/v1/deals?invite=...` | Public invitation preview |
| `POST` | `/api/v1/deals/join` | Join an agreement with private freelancer terms |
| `POST` | `/api/v1/deals/:id/negotiate` | Negotiate terms within each party's private limits |
| `GET` | `/api/v1/deals/:id` | Party-only agreement detail, own mandate, milestones, evidence, and hold |
| `POST` | `/api/v1/deals/:id/sign` | Sign the current immutable terms version |
| `PATCH` | `/api/v1/deals/:id/terms` | Create a new editable terms version before work or payment starts; clears both signatures |
| `POST` | `/api/v1/milestones/:id/fund` | Create a sandbox authorize-intent PayPal order |
| `POST` | `/api/v1/milestones/:id/submissions` | Submit evidence text and optional HTTPS URL |
| `POST` | `/api/v1/milestones/:id/verify` | Run an advisory review against signed criteria |
| `POST` | `/api/v1/milestones/:id/request-revision` | Request a limited revision before capture |
| `POST` | `/api/v1/milestones/:id/release` | Explicitly request a full capture after submission |
| `POST` | `/api/v1/milestones/:id/cancel` | Cancel eligible work and void its authorization |
| `GET` | `/api/v1/ledger` | Read the current user's application audit events |
| `GET`, `POST` | `/api/v1/admin/jobs` | Admin-only job inspection and retry for exhausted jobs |
| `GET` | `/api/v1/paypal/return` and `/api/v1/paypal/cancel` | Complete or record the payer return path |
| `POST` | `/api/webhooks/paypal` | Verify and durably record PayPal webhook events |

Mutation endpoints require a same-origin request and apply basic in-process rate limits. For multi-instance deployment, replace the in-memory limiter with a shared store.

## Checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Database integration tests run when `DATABASE_URL` is set. To run them locally, start PostgreSQL, set `DATABASE_URL`, apply migrations with `npm run db:migrate`, then run `npm test`. GitHub Actions runs the full database-backed test suite, typecheck, lint, and production build against PostgreSQL 16.

## Sandbox walkthrough checklist

Before a hosted walkthrough, configure the Render Blueprint with sandbox PayPal client credentials, webhook ID, `APP_URL`, session secret, database, `EVIDENCE_ALLOWED_HOSTS`, and the desired AI mode/budget. Apply migrations and seed the demo accounts. Verify `/api/health` reports the database and worker as available, then exercise order approval, authorization, evidence submission/review, human release, capture, and void in the PayPal sandbox. Compare the PayPal sandbox order/authorization/capture IDs with `/ledger`; a `PENDING` capture must stay pending until provider confirmation. Record the observed sandbox results before presenting a capture as complete. The demo artifact is available at `/demo/deliverable`.

## Current boundary

This is a sandbox-only prototype, not a production escrow product. The worker retries and reconciles stored operations, but live PayPal behavior must still be verified in the configured sandbox; automated tests and mocks do not prove PayPal integration. Authorization does not guarantee later capture or settlement. Capture requires a separate human action. `PENDING` and `UNKNOWN` remain unresolved; only provider-confirmed capture is shown as completed. Capture goes to the sandbox merchant account. Payouts, refunds, disputes, mediation, and automatic release are intentionally deferred, and the freelancer is not claimed to have been paid.

This repository does not include a recorded hosted walkthrough video or hackathon submission materials. Complete and document the hosted sandbox checklist above before treating the integration as verified.

`render.yaml` provides a Render Blueprint with a paid `0.1c-256mb` Postgres plan and a 1 GB disk; the web service remains on the free plan. This avoids the 30-day expiration for free Postgres. Render credits are applied to eligible charges at the end of each billing period and do not upgrade services automatically. If credits are insufficient, Render may charge the remaining amount to the workspace payment method. Check the workspace balance and credit expiry before continuing paid use. See [Render's pricing](https://render.com/pricing), [credit rules](https://render.com/docs/credits), and [free plan limits](https://render.com/docs/free).
