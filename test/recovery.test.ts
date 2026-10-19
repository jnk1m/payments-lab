import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverPendingOrders } from "../src/recovery.js";
import { type FakeToss, paymentDone, postJson, startApp, startFakeToss } from "./helpers.js";

let toss: FakeToss;
let ctx: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  toss = await startFakeToss();
});
beforeEach(async () => {
  ctx = await startApp();
  toss.calls.length = 0;
  toss.payments = {};
});
afterEach(async () => {
  await ctx.db.query("DROP TRIGGER IF EXISTS fail_payment_insert ON payments");
});
afterAll(async () => {
  await ctx.db.end();
  await toss.close();
});

async function newOrder() {
  const res = await postJson(ctx.app, "/api/orders", {});
  return (await res.json()) as { orderId: string; amount: number };
}
const orderStatus = async (orderId: string) =>
  (await ctx.db.query("SELECT status FROM orders WHERE order_id = $1", [orderId])).rows[0].status;

// Makes every insert into payments fail, like a database that goes away right after Toss approved.
async function breakPaymentWrites() {
  await ctx.db.query(`
    CREATE OR REPLACE FUNCTION fail_payment_insert() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'simulated write failure'; END $$ LANGUAGE plpgsql`);
  await ctx.db.query(
    "CREATE TRIGGER fail_payment_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fail_payment_insert()",
  );
}

describe("recovery", () => {
  it("recovers an order when Toss approved but the DB write failed", async () => {
    const order = await newOrder();
    await breakPaymentWrites();
    const res = await postJson(ctx.app, "/api/payments/confirm", { paymentKey: "pk-r1", orderId: order.orderId, amount: order.amount });
    expect(res.status).toBe(500);
    expect(await orderStatus(order.orderId)).toBe("PENDING");

    await ctx.db.query("DROP TRIGGER fail_payment_insert ON payments");
    toss.calls.length = 0;
    expect(await recoverPendingOrders(ctx.db, 0)).toEqual([{ orderId: order.orderId, result: "settled" }]);
    expect(await orderStatus(order.orderId)).toBe("PAID");
    expect((await ctx.db.query("SELECT 1 FROM payments WHERE payment_key = 'pk-r1'")).rowCount).toBe(1);
    expect(toss.calls).toEqual([`GET /v1/payments/orders/${order.orderId}`]);
  });

  it("recovery refuses to mark PAID when the Toss amount differs from the order amount", async () => {
    const order = await newOrder();
    toss.payments["pk-r2"] = { ...paymentDone, paymentKey: "pk-r2", orderId: order.orderId, totalAmount: 100 };
    expect(await recoverPendingOrders(ctx.db, 0)).toEqual([{ orderId: order.orderId, result: "amount_mismatch" }]);
    expect(await orderStatus(order.orderId)).toBe("PENDING");
    expect((await ctx.db.query("SELECT 1 FROM payments")).rowCount).toBe(0);
    expect(toss.calls).toEqual([`GET /v1/payments/orders/${order.orderId}`]);
  });

  it("recovery is a no-op for orders that Toss never approved", async () => {
    const order = await newOrder();
    expect(await recoverPendingOrders(ctx.db, 0)).toEqual([{ orderId: order.orderId, result: "not_approved" }]);
    expect(await orderStatus(order.orderId)).toBe("PENDING");
    expect((await ctx.db.query("SELECT 1 FROM payments")).rowCount).toBe(0);
  });

  it("recovery skips orders younger than the grace period", async () => {
    await newOrder();
    expect(await recoverPendingOrders(ctx.db, 600)).toEqual([]);
    expect(toss.calls).toEqual([]);
  });
});
