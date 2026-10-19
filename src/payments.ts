import type pg from "pg";
import { PRODUCT } from "./config.js";
import { inTransaction, type Db } from "./db.js";
import { toss, type TossPayment } from "./toss.js";

export class AmountMismatchError extends Error {}
export class UnknownOrderError extends Error {}

export type StoredPayment = { paymentKey: string; orderId: string; amount: number; balanceAmount: number; status: string };
export type OrderStatus = "PENDING" | "PAID" | "PARTIALLY_CANCELED" | "CANCELED";

// Toss payment status -> our order status. Other Toss statuses (READY, ABORTED, ...) never change an order.
export const ORDER_STATUS_FOR: Record<string, OrderStatus> = {
  DONE: "PAID",
  PARTIAL_CANCELED: "PARTIALLY_CANCELED",
  CANCELED: "CANCELED",
};
const RANK: Record<OrderStatus, number> = { PENDING: 0, PAID: 1, PARTIALLY_CANCELED: 2, CANCELED: 3 };

export async function createOrder(db: Db) {
  const orderId = `order-${crypto.randomUUID()}`;
  await db.query("INSERT INTO orders (order_id, order_name, amount) VALUES ($1, $2, $3)", [
    orderId,
    PRODUCT.orderName,
    PRODUCT.amount,
  ]);
  return { orderId, orderName: PRODUCT.orderName, amount: PRODUCT.amount };
}

export async function confirmPayment(
  db: Db,
  input: { paymentKey: string; orderId: string; amount: number },
): Promise<StoredPayment> {
  // The order row stays locked until commit, so a second confirm for the same order waits here,
  // then sees it is no longer PENDING and returns the stored payment instead of calling Toss again.
  // The lock is held across the Toss call; fine for one order at a time, not for long batches.
  return inTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ amount: number; status: string }>(
      "SELECT amount, status FROM orders WHERE order_id = $1 FOR UPDATE",
      [input.orderId],
    );
    const order = rows[0];
    if (!order) throw new UnknownOrderError(`Unknown orderId ${input.orderId}`);

    // The values on the successUrl come from the browser, so check them against our own record first.
    if (order.amount !== input.amount) {
      throw new AmountMismatchError(
        `Amount mismatch for ${input.orderId}: order has ${order.amount}, request has ${input.amount}`,
      );
    }

    if (order.status !== "PENDING") return findPaymentByOrder(tx, input.orderId);

    return (await applyPayment(tx, await toss.confirm(input))).payment;
  });
}

// The only code that changes an order's status. Confirm, cancel, the webhook and recovery all
// hand it a Toss payment object and it decides whether that object is newer than what we have.
// Status only moves forward (PENDING, PAID, PARTIALLY_CANCELED, CANCELED) and the balance only goes
// down, so a late or stale lookup can never undo a cancel. Must run inside a transaction.
export async function applyPayment(
  tx: pg.PoolClient,
  payment: TossPayment,
): Promise<{ payment: StoredPayment; stale: boolean }> {
  const next = ORDER_STATUS_FOR[payment.status];
  if (!next) throw new Error(`Toss status ${payment.status} for ${payment.orderId} cannot be applied to an order`);

  const { rows } = await tx.query<{ amount: number; status: OrderStatus }>(
    "SELECT amount, status FROM orders WHERE order_id = $1 FOR UPDATE",
    [payment.orderId],
  );
  const order = rows[0];
  if (!order) throw new UnknownOrderError(`Unknown orderId ${payment.orderId}`);
  if (order.amount !== payment.totalAmount) {
    throw new AmountMismatchError(
      `Amount mismatch for ${payment.orderId}: order has ${order.amount}, Toss has ${payment.totalAmount}`,
    );
  }

  const current = await tx.query<{ balance_amount: number }>(
    "SELECT balance_amount FROM payments WHERE order_id = $1",
    [payment.orderId],
  );
  const balance = current.rows[0]?.balance_amount;
  const stale = RANK[next] < RANK[order.status] || (balance !== undefined && payment.balanceAmount > balance);

  if (!stale) {
    await tx.query(
      `INSERT INTO payments (payment_key, order_id, amount, balance_amount, status, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (payment_key) DO UPDATE
         SET balance_amount = EXCLUDED.balance_amount, status = EXCLUDED.status, updated_at = now()`,
      [payment.paymentKey, payment.orderId, payment.totalAmount, payment.balanceAmount, payment.status, payment.approvedAt],
    );
    for (const c of payment.cancels ?? []) {
      await tx.query(
        `INSERT INTO payment_cancels (transaction_key, payment_key, cancel_amount, canceled_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (transaction_key) DO NOTHING`,
        [c.transactionKey, payment.paymentKey, c.cancelAmount, c.canceledAt],
      );
    }
    await tx.query("UPDATE orders SET status = $2 WHERE order_id = $1", [payment.orderId, next]);
  }
  return { payment: await findPaymentByOrder(tx, payment.orderId), stale };
}

export async function findPaymentByOrder(db: Pick<Db, "query">, orderId: string): Promise<StoredPayment> {
  const { rows } = await db.query<StoredPayment>(
    `SELECT payment_key AS "paymentKey", order_id AS "orderId", amount, balance_amount AS "balanceAmount", status
     FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Order ${orderId} is past PENDING but has no payment row`);
  return row;
}
