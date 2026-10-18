import { PRODUCT } from "./config.js";
import { inTransaction, type Db } from "./db.js";
import { toss } from "./toss.js";

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
  const { rows } = await db.query<{ amount: number; status: string }>(
    "SELECT amount, status FROM orders WHERE order_id = $1",
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

  if (order.status === "PAID") return findPaymentByOrder(db, input.orderId);

  const payment = await toss.confirm(input);

  return inTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO payments (payment_key, order_id, amount, status, approved_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payment_key) DO NOTHING`,
      [payment.paymentKey, payment.orderId, payment.totalAmount, payment.status, payment.approvedAt],
    );
    await tx.query("UPDATE orders SET status = 'PAID' WHERE order_id = $1", [payment.orderId]);
    return findPaymentByOrder(tx, payment.orderId);
  });
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
