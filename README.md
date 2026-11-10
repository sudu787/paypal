# HoldFast

**Agents help shape the deal. PayPal authorizes the milestone. People decide what happens next.**

HoldFast is a sandbox-only hackathon prototype for service agreements. People can create and join an agreement, negotiate terms with isolated AI context or deterministic replay, sign an immutable version, authorize a milestone through PayPal sandbox, submit evidence, and explicitly request a full capture. Replay verification is intentionally marked unclear; live verification is advisory and the client remains responsible for the release decision.

## Implemented

- Responsive public landing page and authenticated workspace shell.
- Email/password registration and login, signed HTTP-only sessions, logout, demo persona login, and server-side membership checks for agreement reads.
- PostgreSQL schema and initial Drizzle migration for agreements, private mandates, signed terms snapshots, independent work/authorization/capture/payout states, payment operations, webhooks, jobs, AI runs, and audit events.
- Seed script creates demo client/freelancer/admin identities and a sample two-milestone Bakery landing page agreement. Demo accounts have random inaccessible passwords; use the persona buttons.
- PayPal client is locked to `api-m.sandbox.paypal.com`. It supports OAuth, authorize-intent order creation, order lookup, authorization, capture, and void. Payment mutation calls require a plain UUID idempotency key.
- Signed terms, private freelancer mandates, milestone authorization, HTTPS evidence submission, explicit client capture, PayPal return/cancel handling, and webhook signature verification with durable event storage and queue insertion.
- Mandate-checked agent negotiation with a spend ceiling, replay mode, immutable term snapshots, criterion-bound advisory verification, revision requests, eligible authorization voids, and a party-scoped audit ledger.
- Health endpoint reports whether PostgreSQL is connected. No real PayPal payment is made by the seed data.

## Local setup

Requirements: Node.js 20.9 or newer and PostgreSQL 14 or newer.

```powershell
Copy-Item .env.example .env
# Edit DATABASE_URL and SESSION_SECRET in .env
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. The demo buttons sign in as Maya or Arjun after seeding. The first seed creates an illustrative agreement; it does not create a PayPal order or authorization.

For registration and sign-in only, the app can start without a database, but authenticated pages and demo accounts require PostgreSQL. Database migrations are generated into `drizzle/` and applied with `npm run db:migrate`.

## Environment

Start from `.env.example`. Set a unique `SESSION_SECRET` of at least 32 characters. PayPal credentials must be sandbox app credentials. The application rejects any PayPal host other than `api-m.sandbox.paypal.com`, including in production. `PAYOUTS_ENABLED` defaults to false. AI is in replay mode by default. Replay negotiation uses fixed sample agent messages with the draft terms; replay verification marks each criterion unclear and does not inspect the URL. Live AI requires `ANTHROPIC_API_KEY`, respects the daily spend ceiling, and uses configurable token prices. Run `npm run smoke:paypal` to check OAuth connectivity without creating an order or payment.

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
| `POST` | `/api/v1/milestones/:id/fund` | Create a sandbox authorize-intent PayPal order |
| `POST` | `/api/v1/milestones/:id/submissions` | Submit evidence text and optional HTTPS URL |
| `POST` | `/api/v1/milestones/:id/verify` | Run an advisory review against signed criteria |
| `POST` | `/api/v1/milestones/:id/request-revision` | Request a limited revision before capture |
| `POST` | `/api/v1/milestones/:id/release` | Explicitly request a full capture after submission |
| `POST` | `/api/v1/milestones/:id/cancel` | Cancel eligible work and void its authorization |
| `GET` | `/api/v1/ledger` | Read the current user's application audit events |
| `GET` | `/api/v1/paypal/return` and `/api/v1/paypal/cancel` | Complete or record the payer return path |
| `POST` | `/api/webhooks/paypal` | Verify and durably record PayPal webhook events |

Mutation endpoints require a same-origin request and apply basic in-process rate limits. For multi-instance deployment, replace the in-memory limiter with a shared store.

## Checks

```powershell
npm run typecheck
npm run lint
npm run build
```

## Current boundary

This is not a production-ready escrow product. Webhook events are verified and durably queued, but this repository does not yet run a worker for event processing and reconciliation. Deal-term editing after creation, automated retries, and operational monitoring remain unfinished. An authorization is not a guarantee of later capture or settlement; capture requires a separate explicit action and remains subject to PayPal's decisions. The demo should stop at a confirmed capture to the sandbox merchant account; payouts are disabled and are not claimed.

`render.yaml` provides a Render Blueprint. Its free Postgres plan expires after 30 days, so upgrade or move the database before that deadline if the deployment needs to persist. [Render's free plan documentation](https://render.com/docs/free) lists the current limits.
