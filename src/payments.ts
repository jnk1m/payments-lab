import { PRODUCT } from "./config.js";
import type pg from "pg";
import { inTransaction, type Db } from "./db.js";
import { toss, type TossPayment } from "./toss.js";

export class AmountMismatchError extends Error {}
export class UnknownOrderError extends Error {}

export type StoredPayment = { paymentKey: string; orderId: string; amount: number; status: string };

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
  // then sees PAID and returns the stored payment instead of calling Toss again.
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

    if (order.status === "PAID") return findPaymentByOrder(tx, input.orderId);

    return settle(tx, await toss.confirm(input));
  });
}

// The only code that marks an order PAID. Confirm, the webhook and recovery all end here,
// so the amount check and the PAID transition cannot drift apart between them.
// Must run inside a transaction: the order row stays locked until the caller commits.
export async function settle(tx: pg.PoolClient, payment: TossPayment): Promise<StoredPayment> {
  const { rows } = await tx.query<{ amount: number; status: string }>(
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
  if (order.status === "PAID") return findPaymentByOrder(tx, payment.orderId);

  await tx.query(
    `INSERT INTO payments (payment_key, order_id, amount, status, approved_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (payment_key) DO NOTHING`,
    [payment.paymentKey, payment.orderId, payment.totalAmount, payment.status, payment.approvedAt],
  );
  await tx.query("UPDATE orders SET status = 'PAID' WHERE order_id = $1", [payment.orderId]);
  return findPaymentByOrder(tx, payment.orderId);
}

async function findPaymentByOrder(db: Pick<Db, "query">, orderId: string): Promise<StoredPayment> {
  const { rows } = await db.query<StoredPayment>(
    `SELECT payment_key AS "paymentKey", order_id AS "orderId", amount, status
     FROM payments WHERE order_id = $1`,
    [orderId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Order ${orderId} is PAID but has no payment row`);
  return row;
}
