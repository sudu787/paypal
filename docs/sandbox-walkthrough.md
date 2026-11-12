# Hosted sandbox walkthrough — 2026-11-12

Run against https://holdfast-06f4.onrender.com (PayPal **sandbox**, `api-m.sandbox.paypal.com`), demo client and freelancer personas, the sample "Bakery landing page" agreement. A US Personal sandbox buyer approved each order. IDs below are the values the PayPal sandbox API returned, as recorded in the app's ledger. They were not separately cross-checked in the PayPal sandbox dashboard.

## Milestone 1 — "Structure & content" ($260.00 USD): authorize → evidence → human release → capture

| Step | Result |
| --- | --- |
| Order created (AUTHORIZE intent) | `24897533S9679184J` |
| Buyer approval, return handled, order authorized | Authorization `519023918F843320N` (status `CREATED`) |
| Freelancer evidence submitted | Text plus `https://holdfast-06f4.onrender.com/demo/deliverable` |
| Advisory AI review | **Failed**: Gemini returned HTTP 403 (API key rejected). No AI report was produced. |
| Client explicit release (`confirm_amount_cents: 26000`) | Capture `0UA54222GX121174P`, status `COMPLETED`, $260.00 |
| Payout | None. Payouts are disabled; the capture goes to the sandbox merchant account, not to the freelancer. |

## Milestone 2 — "Order form & launch" ($260.00 USD): authorize → void

| Step | Result |
| --- | --- |
| Order created | `65H66744X22273040` |
| Buyer approval, authorization | Authorization `0L740884MS0233445` |
| Client cancels eligible work | Authorization `VOIDED`, work `CANCELLED` |

## Ledger events (newest first)

`AUTHORIZATION_VOIDED` and `AUTHORIZATION_VOID_REQUESTED` (`0L740884MS0233445`), `AUTHORIZATION_CONFIRMED` (`0L740884MS0233445`), `AUTHORIZATION_REQUESTED` and `ORDER_CREATED` (`65H66744X22273040`), `CAPTURE_COMPLETED` (`0UA54222GX121174P`), `CAPTURE_REQUESTED` (`519023918F843320N`), `WORK_SUBMITTED`, `AUTHORIZATION_CONFIRMED` (`519023918F843320N`), `AUTHORIZATION_REQUESTED` and `ORDER_CREATED` (`24897533S9679184J`). Earlier `ORDER_CREATE_REQUESTED` rows are attempts made before sandbox credentials were configured. Those attempts were recorded as failed and never reached PayPal.

## Issues found during the run

- PayPal return and cancel redirects and invite links used Render's internal `localhost:10000` origin. Fixed in `f3b1743` (they now use `APP_URL`), and milestone 2's return confirmed the fix on the hosted app.
- Approving in a browser that is not signed in to HoldFast gets the return rejected (`UNAUTHENTICATED`), leaving the order approved but not authorized. Completing the return URL in the signed-in browser authorized it.
- PayPal refused an India Personal buyer paying the India Business sandbox merchant in USD ("This seller doesn't accept payments in your currency"). A US Personal buyer worked.

## Not verified

- Live AI negotiation and verification. Gemini returns 403 because Google reports "The Gemini API free tier is not available for this project": eligibility is per Google Cloud project, so a new key in the same project does not help.
- Webhook delivery to the hosted URL.

## Second run (recorded for the demo video), 2026-11-12

A fresh demo session went through the same flow on milestone 1: order `70401806MM5459351`, authorization `204755462M043094X`, then an explicit client release, capture `6KH70411063065422` `COMPLETED` ($260.00). The advisory Gemini review was attempted after the user replaced the API key, but still returned HTTP 403, so the video shows no AI report.

After the root cause was found, the hosted app was switched to `AI_MODE=replay`. Replay negotiation then returned `TERMS_PROPOSED` on the hosted app. Live AI needs a Gemini key from a free-tier-eligible project.

Later the hosted app was switched to OpenRouter (`AI_PROVIDER=openrouter`, `AI_MODE=live`). The first live negotiation was cut off because the reasoning model ran out of tokens (`length`); this was fixed in `ff5947c`. After the fix, live negotiation returned `TERMS_PROPOSED` with two validated agent turns.
