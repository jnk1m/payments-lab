# 0003 A cancel cannot be rolled back, so write the intent first

Status: accepted, 2026-10-19

## Context
STATES.md P9, P10, P15. A cancel at Toss returns money; our transaction rolling back does not bring it back. Measured with the docs test key on 2026-10-18: the same 1,000 won partial cancel sent twice without an Idempotency-Key was applied twice (balance 10,000 → 9,000 → 8,000); sent again with the same key it was applied once. So the key protects against retries, but not against two different requests that together exceed the balance, and not against our database failing after Toss succeeded.

## Decision
- The caller sends `Idempotency-Key` on `POST /api/orders/:orderId/cancel`. In one short transaction, with the order row locked, we check the order is `PAID` or `PARTIALLY_CANCELED`, that no other cancel for this order is still `REQUESTED`, and that the amount is a positive integer no larger than the balance. Then we insert a `cancel_requests` row `REQUESTED` and release the lock.
- We call Toss with `Idempotency-Key: cancel-{orderId}-{requestKey}`, apply the returned payment through `applyPayment` (which also stores every cancel transaction Toss lists), and mark the request `DONE`.
- A Toss 4xx marks it `FAILED`, except 409 `IDEMPOTENT_REQUEST_PROCESSING`, which means Toss is still working on it. A 409, a timeout, a Toss 5xx or our own DB failing leaves it `REQUESTED`; `npm run recover` replays it with the same key and reports `retry_later` if it is still not settled.
- The same request key again: `DONE` answers with the current state and no Toss call; `REQUESTED` answers 409; `FAILED` answers 409 with the Toss error code; a different amount answers 422.
- A different request key while one is `REQUESTED` answers 409 `CANCEL_IN_PROGRESS`.

## Rejected
- Holding the order lock across the Toss call (what confirm does). It would also work for concurrency, but a 65 second timeout would block webhooks for that order, and a failure after Toss succeeded would leave no trace to recover from.
- Generating the Toss key on the server per request. A client retry would get a new key and cancel twice.
- Trusting the Idempotency-Key as the only guard. Two different keys can still over-cancel; the balance check under the lock is the last line.
- Allowing several cancels in flight and reserving their amounts against the balance (the first version of this change). A webhook or recovery can apply a cancel before its request is marked `DONE`, and then the reservation is subtracted twice: a "cancel the rest" request would silently refund too little. Found in review before merge.

## Accepted cost
- Only one cancel per order at a time. A customer who asks for two partial refunds in the same second gets a 409 on the second and retries.
- Toss keeps a key for 15 days. Recovery refuses to replay a request older than 14 days and reports it for a person, because a replay after the window could cancel twice. That row keeps blocking new cancels for the order until a person checks the payment at Toss and closes it: `UPDATE cancel_requests SET status = 'DONE' (or 'FAILED'), updated_at = now() WHERE order_id = ... AND request_key = ...`, then `npm run recover` or a webhook brings the balance in line.
- Cancel webhooks for domestic payments are not described in the Toss docs, so the repo does not wait for one. Recovery and reconciliation are the safety net.

## Out of scope, said plainly
Splitting a refund across coupons or points, cancels after settlement, cancel fees, and payment-method limits (escrow, cash cards, virtual accounts before deposit) are not modelled. The first question for each would be: who absorbs the remainder, which settlement period takes the negative amount, who pays the fee, and which Toss error tells us the method refused.

## Interview line
A cancel cannot be undone, so I write down what I am about to cancel before calling Toss, allow one cancel per order at a time, and replay with the same key if I never saw the answer.
