# payments-lab SPEC

## Goal

A small, readable reference for three things a payments backend has to get right, built on the Toss Payments test environment:

1. Confirm a payment only after checking the amount.
2. Treat a webhook as a hint, and take the state from the payment lookup API.
3. Find mismatches between Toss transactions and our own records.

Audience: a hiring manager or reviewer who reads the repo in about 10 minutes. Total source should stay small (target: under 600 lines in `src/` and `scripts/`, excluding tests and the HTML page).

## Stack

TypeScript, Node 22+, Hono, PostgreSQL 16 (docker compose), vitest, eslint. Toss Payments payment widget v2 and Core API, test keys only.

## Requirements

### R1 Payment confirmation

- R1.1 `POST /api/orders` creates an order. The amount comes from the server, never from the client.
- R1.2 `POST /api/payments/confirm` takes `paymentKey`, `orderId`, `amount` (the values on the successUrl).
- R1.3 If `amount` differs from the stored order amount, respond 400, do not call Toss, and mark nothing as paid.
- R1.4 If the amounts match, call Toss `POST /v1/payments/confirm`, then store the payment (paymentKey, orderId, amount, status) and set the order to `PAID` in one transaction.
- R1.5 Confirming the same order twice does not call Toss twice and returns the stored payment.
- R1.6 If Toss rejects the confirmation, respond with the Toss error code and message, store nothing as paid, and keep the order `PENDING`.

### R2 Webhook

- R2.1 `POST /webhooks/toss` accepts the `PAYMENT_STATUS_CHANGED` body format from the Toss docs.
- R2.2 The body is not trusted for state. The handler calls `GET /v1/payments/{paymentKey}` and writes the status and amount from that response.
- R2.3 A webhook with the same `tosspayments-webhook-transmission-id` header is applied once. Later copies return 200 and change nothing.
- R2.4 If the lookup call fails, respond 500 and do not record the event as processed, so Toss retries.
- R2.5 A webhook for a payment we do not know returns 200 and changes nothing.
- R2.6 `npm run webhook:send` sends a docs-format webhook to the local server, because the local server is not reachable from Toss.

### R3 Reconciliation

- R3.1 `npm run reconcile -- <from> <to>` fetches Toss transactions for the period (`GET /v1/transactions`, paginated) and compares them with local payments in the same period.
- R3.2 It reports four kinds: `MISSING_IN_DB` (only at Toss), `MISSING_AT_TOSS` (only local), `AMOUNT_MISMATCH`, `STATUS_MISMATCH`.
- R3.3 Exit code is 0 when there are no mismatches and 1 otherwise.

### R4 Tests

- R4.1 Integration tests for R1, R2, R3 run against a real PostgreSQL.
- R4.2 Toss responses come from recorded-format JSON fixtures served by a local HTTP server. The app code uses its real HTTP client. No mocking of our own modules.

### R5 Recovery

- R5.1 `settle` is the only code that sets an order to `PAID`. It locks the order row and compares the Toss amount with the order amount. Confirm, the webhook and recovery all use it.
- R5.2 `npm run recover -- [graceSeconds]` looks up orders still `PENDING` after the grace period with `GET /v1/payments/orders/{orderId}` and settles those Toss reports as `DONE`. It never calls confirm or cancel.
- R5.3 A Toss amount that differs from the order amount leaves the order `PENDING` and makes the command exit 1.
- R5.4 A webhook for an approved payment of a known order settles it, even if confirm has not committed yet. A webhook that still cannot be matched does not keep its transmission id, so a Toss retry is processed again.

## Acceptance criteria

| # | Criterion |
|---|---|
| A1 | `docker compose up -d` then `npm test` passes all tests (target: at least 19) |
| A2 | `npm run lint` and `npm run typecheck` pass with 0 errors |
| A3 | Tampered amount: 0 Toss calls, order stays `PENDING` (tested) |
| A4 | The same webhook sent 3 times: 1 lookup call, 1 stored event (tested) |
| A5 | Reconcile on a fixture with 1 of each mismatch kind reports exactly 4 items (tested) |
| A6 | One test payment completes in a real browser on localhost with the docs test keys |
| A7 | No real or live key anywhere in the repo (`grep` for `live_` returns nothing) |
| A8 | Toss approved but the DB write failed: recovery settles the order with 1 lookup call and 0 confirm calls (tested) |

## Not doing

- Live keys, real money, any production deployment.
- Partial cancel, refund flow, virtual accounts, billing keys.
- Settlement (정산) calculation.
- Webhook signature checks (the docs describe signatures only for payout and seller events; this event is verified by lookup instead).
- Auth, users, carts, an admin UI, a job queue, an ORM.
- Real Toss webhook delivery to localhost.

## Do not change

- Amounts are integers in KRW.
- Only the Toss documentation test keys appear in the repo.
