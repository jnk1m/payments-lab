# 0001 One path to PAID, and a recovery command

Status: accepted, 2026-10-19

## Context
STATES.md P1 and P2. If Toss approves and our database write fails, or the confirm response never reaches us, the customer has paid and the order stays `PENDING`. Before this change only reconciliation would notice, and nothing could fix it. The webhook (P3) needs to mark orders paid too, so there would be three places that set `PAID`.

## Decision
- `settle(tx, payment)` is the only code that sets an order to `PAID`. It locks the order row, compares the Toss amount with the order amount, and is a no-op if the order is already `PAID`.
- Confirm, the webhook and `npm run recover` all call it.
- `npm run recover -- [graceSeconds]` looks at orders still `PENDING` after a grace period (default 600s), asks Toss with `GET /v1/payments/orders/{orderId}`, and settles the ones Toss reports as `DONE`. It never calls confirm or cancel. It exits 1 if any order has an amount mismatch, so it can run from cron.

## Rejected
- Retrying the database write inside the confirm request. It does not help when the process dies or the response is lost, which is the case that matters.
- Letting recovery call confirm again with the stored values. Recovery should only read Toss; approving is the customer's action.
- A job queue. One command on a timer covers it at this size.

## Accepted cost
- An order can sit unpaid in our database for up to the grace period plus the cron interval.
- Recovery trusts the lookup status `DONE` only. Payments that were approved and cancelled before we recorded them are left to reconciliation until cancels exist (milestone 2).

## Interview line
Even when the confirm response is lost, recovery asks Toss by order id, and the order only becomes PAID through one function that checks the amount every time.
