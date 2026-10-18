import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeToss, postJson, startApp, startFakeToss } from "./helpers.js";

let toss: FakeToss;
let ctx: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  toss = await startFakeToss();
});
beforeEach(async () => {
  ctx = await startApp();
  toss.calls.length = 0;
  toss.rejectConfirm = false;
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

describe("payment confirmation", () => {
  it("confirms with Toss and stores the payment when the amount matches", async () => {
    const order = await newOrder();
    const res = await postJson(ctx.app, "/api/payments/confirm", {
      paymentKey: "pk-1", orderId: order.orderId, amount: String(order.amount),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paymentKey: "pk-1", amount: 15000, status: "DONE" });
    expect(await orderStatus(order.orderId)).toBe("PAID");
    expect(toss.calls).toEqual(["POST /v1/payments/confirm"]);
  });

  it("rejects a tampered amount without calling Toss", async () => {
    const order = await newOrder();
    const res = await postJson(ctx.app, "/api/payments/confirm", {
      paymentKey: "pk-2", orderId: order.orderId, amount: 100,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(toss.calls).toEqual([]);
    expect(await orderStatus(order.orderId)).toBe("PENDING");
  });

  it("returns the stored payment on a second confirm without calling Toss again", async () => {
    const order = await newOrder();
    const body = { paymentKey: "pk-3", orderId: order.orderId, amount: order.amount };
    await postJson(ctx.app, "/api/payments/confirm", body);
    const second = await postJson(ctx.app, "/api/payments/confirm", body);
    expect(second.status).toBe(200);
    expect(toss.calls).toEqual(["POST /v1/payments/confirm"]);
    const { rows } = await ctx.db.query("SELECT 1 FROM payments");
    expect(rows).toHaveLength(1);
  });

  it("surfaces a Toss rejection and keeps the order PENDING", async () => {
    toss.rejectConfirm = true;
    const order = await newOrder();
    const res = await postJson(ctx.app, "/api/payments/confirm", {
      paymentKey: "pk-4", orderId: order.orderId, amount: order.amount,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "REJECT_CARD_COMPANY" });
    expect(await orderStatus(order.orderId)).toBe("PENDING");
    expect((await ctx.db.query("SELECT 1 FROM payments")).rowCount).toBe(0);
  });

  it("returns 404 for an unknown order", async () => {
    const res = await postJson(ctx.app, "/api/payments/confirm", { paymentKey: "pk-5", orderId: "order-nope", amount: 15000 });
    expect(res.status).toBe(404);
    expect(toss.calls).toEqual([]);
  });
});
