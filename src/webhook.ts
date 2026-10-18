import { inTransaction, type Db } from "./db.js";
import { toss } from "./toss.js";

// Shape documented at https://docs.tosspayments.com/reference/using-api/webhook-events
export type WebhookBody = {
  eventType: string;
  createdAt: string;
  data: { paymentKey?: string; orderId?: string };
};

export type WebhookResult = "applied" | "duplicate" | "unknown_payment" | "ignored";

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
    const updated = await tx.query(
      "UPDATE payments SET status = $2, amount = $3, updated_at = now() WHERE payment_key = $1",
      [payment.paymentKey, payment.status, payment.totalAmount],
    );
    return updated.rowCount === 0 ? "unknown_payment" : "applied";
  });
}
