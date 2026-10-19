# 0001 One function changes order status, and a recovery command

Status: accepted, 2026-10-19 (widened the same day from "one path to PAID" when cancels arrived)

## Context
STATES.md P1 and P2. If Toss approves and our database write fails, or the confirm response never reaches us, the customer has paid and the order stays `PENDING`. Before this change only reconciliation would notice, and nothing could fix it. The webhook (P3), cancels (P9) and recovery all need to change order status too, so there would be four places that do it, each able to drift from the others.

## Decision
- `applyPayment(tx, tossPayment)` is the only code that changes an order's status. It locks the order row, compares the Toss total with the order amount, and only moves forward: `PENDING` → `PAID` → `PARTIALLY_CANCELED` → `CANCELED`, with the balance only going down. A Toss object that would move backwards is reported as stale and ignored (P5).
- Confirm, cancel, the webhook and `npm run recover` all hand it the Toss payment object they got.
- `npm run recover -- [graceSeconds]` looks at orders still `PENDING` after a grace period (default 600s), asks Toss with `GET /v1/payments/orders/{orderId}`, and applies what Toss reports. It never calls confirm. It exits 1 if anything needs a person.

## Rejected
- Retrying the database write inside the confirm request. It does not help when the process dies or the response is lost, which is the case that matters.
- Letting recovery call confirm again with the stored values. Recovery should only read Toss; approving is the customer's action.
- Comparing webhook timestamps to decide which lookup is newer. Status order and balance are facts about money; timestamps from different calls are not.
- A job queue. One command on a timer covers it at this size.

## Accepted cost
- An order can sit unpaid in our database for up to the grace period plus the cron interval.
- "Forward only" assumes Toss never reverses a cancel. If a cancel can be undone at Toss, this rule would hide it and reconciliation would have to catch it.

## Interview line
Every status change goes through one function that checks the amount and only lets status move forward, so a lost response, a late webhook or a stale lookup cannot pay an order twice or bring a cancelled order back.
