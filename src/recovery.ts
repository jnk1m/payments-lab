import { inTransaction, type Db } from "./db.js";
import { AmountMismatchError, settle } from "./payments.js";
import { toss, TossError } from "./toss.js";

export type RecoveryResult = { orderId: string; result: "settled" | "not_approved" | "amount_mismatch" };

// Finds orders still PENDING after the grace period and asks Toss, by orderId, whether they were
// approved. This covers a confirm whose response was lost and a confirm whose DB write failed.
// It only settles; it never calls confirm or cancel.
export async function recoverPendingOrders(db: Db, graceSeconds: number): Promise<RecoveryResult[]> {
  const { rows } = await db.query<{ order_id: string }>(
    "SELECT order_id FROM orders WHERE status = 'PENDING' AND created_at <= now() - make_interval(secs => $1) ORDER BY created_at",
    [graceSeconds],
  );
  const results: RecoveryResult[] = [];
  for (const { order_id: orderId } of rows) {
    let payment;
    try {
      payment = await toss.getPaymentByOrderId(orderId);
    } catch (err) {
      if (err instanceof TossError && err.httpStatus === 404) {
        results.push({ orderId, result: "not_approved" });
        continue;
      }
      throw err;
    }
    if (payment.status !== "DONE") {
      results.push({ orderId, result: "not_approved" });
      continue;
    }
    try {
      await inTransaction(db, (tx) => settle(tx, payment));
      results.push({ orderId, result: "settled" });
    } catch (err) {
      if (!(err instanceof AmountMismatchError)) throw err;
      results.push({ orderId, result: "amount_mismatch" });
    }
  }
  return results;
}
