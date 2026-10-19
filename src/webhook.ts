import { inTransaction, type Db } from "./db.js";
import { AmountMismatchError, applyPayment, ORDER_STATUS_FOR } from "./payments.js";
import { toss } from "./toss.js";

// Shape documented at https://docs.tosspayments.com/reference/using-api/webhook-events
export type WebhookBody = {
  eventType: string;
  createdAt: string;
  data: { paymentKey?: string; orderId?: string };
};

export type WebhookResult = "applied" | "stale" | "duplicate" | "unknown_payment" | "amount_mismatch" | "ignored";

export async function handleWebhook(db: Db, transmissionId: string, body: WebhookBody): Promise<WebhookResult> {
  const paymentKey = body.data?.paymentKey;
  if (body.eventType !== "PAYMENT_STATUS_CHANGED" || !paymentKey) return "ignored";

  // One transaction: if the lookup fails, the event row rolls back and a Toss retry is processed again.
  return inTransaction(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO webhook_events (transmission_id, payment_key) VALUES ($1, $2)
       ON CONFLICT (transmission_id) DO NOTHING`,
      [transmissionId, paymentKey],
    );
    if (inserted.rowCount === 0) return "duplicate";

    // The webhook body is only a hint. State comes from the lookup response.
    const payment = await toss.getPayment(paymentKey);
    const order = await tx.query("SELECT 1 FROM orders WHERE order_id = $1", [payment.orderId]);
    if (order.rowCount === 0) {
      // Do not keep the transmission id, so a Toss retry of this delivery is looked at again.
      await tx.query("DELETE FROM webhook_events WHERE transmission_id = $1", [transmissionId]);
      return "unknown_payment";
    }
    if (!ORDER_STATUS_FOR[payment.status]) return "ignored";

    // Covers a webhook that beats our confirm (ADR 0002) and two webhooks whose lookups race:
    // applyPayment refuses a lookup older than what we already stored.
    try {
      return (await applyPayment(tx, payment)).stale ? "stale" : "applied";
    } catch (err) {
      if (!(err instanceof AmountMismatchError)) throw err;
      console.error(err.message); // left as is for a person; reconcile reports it too
      return "amount_mismatch";
    }
  });
}
