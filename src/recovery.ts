import { sendCancel } from "./cancel.js";
import { inTransaction, type Db } from "./db.js";
import { AmountMismatchError, applyPayment, ORDER_STATUS_FOR } from "./payments.js";
import { toss, TossError } from "./toss.js";

export type RecoveryResult = { orderId: string; result: "settled" | "not_approved" | "amount_mismatch" | "error"; error?: string };
export type CancelRecoveryResult = {
  orderId: string;
  requestKey: string;
  result: "done" | "failed" | "retry_later" | "too_old_for_replay" | "error";
  error?: string;
};

// Toss keeps an Idempotency-Key for 15 days. Past that a replay could cancel twice, so stop a day early.
const REPLAY_LIMIT_DAYS = 14;

// Finds orders still PENDING after the grace period and asks Toss, by orderId, whether they were
// approved. This covers a confirm whose response was lost and a confirm whose DB write failed.
// It only applies what Toss reports; it never calls confirm.
export async function recoverPendingOrders(db: Db, graceSeconds: number): Promise<RecoveryResult[]> {
  const { rows } = await db.query<{ order_id: string }>(
    "SELECT order_id FROM orders WHERE status = 'PENDING' AND created_at <= now() - make_interval(secs => $1) ORDER BY created_at",
    [graceSeconds],
  );
  const results: RecoveryResult[] = [];
  // One failing order is reported and does not stop the others.
  for (const { order_id: orderId } of rows) {
    try {
      results.push({ orderId, result: await recoverOrder(db, orderId) });
    } catch (err) {
      results.push({ orderId, result: "error", error: String(err) });
    }
  }
  return results;
}

async function recoverOrder(db: Db, orderId: string): Promise<"settled" | "not_approved" | "amount_mismatch"> {
  let payment;
  try {
    payment = await toss.getPaymentByOrderId(orderId);
  } catch (err) {
    if (err instanceof TossError && err.httpStatus === 404) return "not_approved";
    throw err;
  }
  if (!ORDER_STATUS_FOR[payment.status]) return "not_approved";
  try {
    await inTransaction(db, (tx) => applyPayment(tx, payment));
    return "settled";
  } catch (err) {
    if (err instanceof AmountMismatchError) return "amount_mismatch";
    throw err;
  }
}

// Finds cancels we recorded but never saw finish (Toss timeout, or our DB failed after Toss cancelled)
// and replays them with the same key. Toss returns the first result if the cancel happened, or performs it.
export async function recoverCancelRequests(db: Db, graceSeconds: number): Promise<CancelRecoveryResult[]> {
  const { rows } = await db.query<{
    order_id: string;
    request_key: string;
    payment_key: string;
    cancel_amount: number;
    cancel_reason: string;
    too_old: boolean;
  }>(
    `SELECT order_id, request_key, payment_key, cancel_amount, cancel_reason,
            created_at < now() - make_interval(days => $2) AS too_old
     FROM cancel_requests
     WHERE status = 'REQUESTED' AND created_at <= now() - make_interval(secs => $1)
     ORDER BY created_at`,
    [graceSeconds, REPLAY_LIMIT_DAYS],
  );
  const results: CancelRecoveryResult[] = [];
  for (const r of rows) {
    const id = { orderId: r.order_id, requestKey: r.request_key };
    if (r.too_old) {
      results.push({ ...id, result: "too_old_for_replay" });
      continue;
    }
    try {
      await sendCancel(db, { ...id, paymentKey: r.payment_key, cancelAmount: r.cancel_amount, cancelReason: r.cancel_reason });
      results.push({ ...id, result: "done" });
    } catch (err) {
      // sendCancel decides FAILED; anything it left REQUESTED (409 still processing, 5xx, timeout) is retried next run.
      const now = await db.query<{ status: string }>(
        "SELECT status FROM cancel_requests WHERE order_id = $1 AND request_key = $2",
        [r.order_id, r.request_key],
      );
      if (now.rows[0]?.status === "FAILED") results.push({ ...id, result: "failed" });
      else if (err instanceof TossError) results.push({ ...id, result: "retry_later" });
      else results.push({ ...id, result: "error", error: String(err) });
    }
  }
  return results;
}
