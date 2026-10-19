# 0002 A webhook that arrives before confirm

Status: accepted, 2026-10-19

## Context
STATES.md P3. Toss can send `PAYMENT_STATUS_CHANGED` before our confirm transaction commits. The old handler found no payment row, answered `unknown_payment` with 200, and had already stored the transmission id. Toss does not retry a 200, and our own retry check would have called it a duplicate anyway, so the event was lost. The reproduction test failed on the old code before the fix.

## Decision
- If the lookup says `DONE` and the order exists, the webhook calls `applyPayment` (ADR 0001). The order lock makes it wait for an in-flight confirm, then it sees `PAID` and does nothing extra.
- If the payment still cannot be matched, the handler deletes the transmission id in the same transaction and answers `unknown_payment`, so a Toss retry of that delivery is processed again.
- If the Toss amount differs from the order amount, the order stays `PENDING`, the handler answers `amount_mismatch`, and the message is logged. Reconcile reports it too.

## Rejected
- Answering 500 for unknown payments so Toss retries. Payments for other systems or deleted orders would be retried 7 times over almost four days for nothing (intervals 1 to 4096 minutes in the Toss docs).
- Storing the webhook body and applying it later. The body is not trusted for state (design decision 1); the lookup is.

## Accepted cost
- The webhook may wait on the order lock while a confirm holds it during the Toss call. Toss expects a reply within 10 seconds and retries otherwise, which is safe here.

## Interview line
If the webhook comes first, it goes through the same function as confirm, and anything it cannot match is left for Toss to send again instead of being marked done.
