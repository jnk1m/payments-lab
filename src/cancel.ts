import { inTransaction, type Db } from "./db.js";
import { applyPayment } from "./payments.js";
import { toss, TossError } from "./toss.js";

export type CancelResult = { orderId: string; status: string; balanceAmount: number };

// code is what the API returns; httpStatus is the response status.
export class CancelRejected extends Error {
  constructor(public httpStatus: 400 | 404 | 409 | 422, public code: string, message: string) {
    super(message);
  }
}

export async function cancelOrder(
  db: Db,
  input: { orderId: string; requestKey: string; cancelReason: string; cancelAmount?: unknown },
): Promise<CancelResult> {
  if (input.cancelAmount !== undefined && !isPositiveInteger(input.cancelAmount)) {
    throw new CancelRejected(400, "INVALID_AMOUNT", `cancelAmount must be a positive integer, got ${String(input.cancelAmount)}`);
  }
  // Step 1: record the intent, then release the lock before calling Toss.
  const intent = await inTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ status: string }>("SELECT status FROM orders WHERE order_id = $1 FOR UPDATE", [
      input.orderId,
    ]);
    const order = rows[0];
    if (!order) throw new CancelRejected(404, "UNKNOWN_ORDER", `Unknown orderId ${input.orderId}`);

    const existing = await tx.query<{ status: string; cancel_amount: number; error_code: string | null }>(
      "SELECT status, cancel_amount, error_code FROM cancel_requests WHERE order_id = $1 AND request_key = $2",
      [input.orderId, input.requestKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (input.cancelAmount !== undefined && input.cancelAmount !== prior.cancel_amount) {
        throw new CancelRejected(422, "KEY_REUSED", `Key ${input.requestKey} was used for ${prior.cancel_amount}`);
      }
      if (prior.status === "REQUESTED") throw new CancelRejected(409, "CANCEL_IN_PROGRESS", "The same request is still running");
      if (prior.status === "FAILED") throw new CancelRejected(409, prior.error_code ?? "CANCEL_FAILED", "This request already failed");
      return null; // DONE: answer with the current state, no Toss call
    }

    if (order.status !== "PAID" && order.status !== "PARTIALLY_CANCELED") {
      throw new CancelRejected(409, "NOT_CANCELABLE", `Order ${input.orderId} is ${order.status}`);
    }
    // One cancel in flight per order. Until it is DONE or FAILED we cannot know the balance,
    // because a webhook or recovery may already have applied it.
    const inFlight = await tx.query("SELECT 1 FROM cancel_requests WHERE order_id = $1 AND status = 'REQUESTED'", [
      input.orderId,
    ]);
    if (inFlight.rowCount) throw new CancelRejected(409, "CANCEL_IN_PROGRESS", `Another cancel for ${input.orderId} is running`);

    const { rows: paid } = await tx.query<{ payment_key: string; balance_amount: number }>(
      "SELECT payment_key, balance_amount FROM payments WHERE order_id = $1",
      [input.orderId],
    );
    const row = paid[0];
    if (!row) throw new Error(`Order ${input.orderId} is ${order.status} but has no payment row`);
    const paymentKey = row.payment_key;
    const amount = (input.cancelAmount as number | undefined) ?? row.balance_amount;
    if (amount > row.balance_amount) {
      throw new CancelRejected(400, "EXCEEDS_BALANCE", `Cancel ${amount} is more than the balance ${row.balance_amount}`);
    }
    await tx.query(
      `INSERT INTO cancel_requests (order_id, request_key, payment_key, cancel_amount, cancel_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.orderId, input.requestKey, paymentKey, amount, input.cancelReason],
    );
    return { paymentKey, amount };
  });

  if (intent) {
    await sendCancel(db, {
      orderId: input.orderId,
      requestKey: input.requestKey,
      paymentKey: intent.paymentKey,
      cancelAmount: intent.amount,
      cancelReason: input.cancelReason,
    });
  }
  const { rows } = await db.query<CancelResult>(
    `SELECT o.order_id AS "orderId", o.status, p.balance_amount AS "balanceAmount"
     FROM orders o JOIN payments p USING (order_id) WHERE o.order_id = $1`,
    [input.orderId],
  );
  return rows[0]!;
}

const isPositiveInteger = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

// Step 2, also used by recovery: send the recorded cancel with a key derived from the request key.
// Toss answers a repeated key with the first result for 15 days, so replaying is safe within that window.
// A Toss 4xx other than 409 (still processing) marks the request FAILED. Anything else (409, timeout,
// 5xx, our own DB failing) leaves it REQUESTED for recovery.
export async function sendCancel(
  db: Db,
  r: { orderId: string; requestKey: string; paymentKey: string; cancelAmount: number; cancelReason: string },
): Promise<void> {
  let payment;
  try {
    payment = await toss.cancel(
      r.paymentKey,
      { cancelReason: r.cancelReason, cancelAmount: r.cancelAmount },
      `cancel-${r.orderId}-${r.requestKey}`,
    );
  } catch (err) {
    if (err instanceof TossError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 409) {
      await db.query(
        "UPDATE cancel_requests SET status = 'FAILED', error_code = $3, updated_at = now() WHERE order_id = $1 AND request_key = $2",
        [r.orderId, r.requestKey, err.code],
      );
    }
    throw err;
  }
  await inTransaction(db, async (tx) => {
    await applyPayment(tx, payment);
    await tx.query(
      "UPDATE cancel_requests SET status = 'DONE', updated_at = now() WHERE order_id = $1 AND request_key = $2",
      [r.orderId, r.requestKey],
    );
  });
}
