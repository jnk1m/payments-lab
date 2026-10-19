import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverCancelRequests } from "../src/recovery.js";
import { type FakeToss, postJson, startApp, startFakeToss } from "./helpers.js";

let toss: FakeToss;
let ctx: Awaited<ReturnType<typeof startApp>>;
let orderId: string;

beforeAll(async () => {
  toss = await startFakeToss();
});
beforeEach(async () => {
  ctx = await startApp();
  toss.payments = {};
  toss.appliedCancels = 0;
  toss.cancelDelayMs = 0;
  toss.idempotencyKeys.length = 0;
  const order = await (await postJson(ctx.app, "/api/orders", {})).json();
  orderId = order.orderId;
  await postJson(ctx.app, "/api/payments/confirm", { paymentKey: "pk-c", orderId, amount: order.amount });
  toss.calls.length = 0;
});
afterEach(async () => {
  await ctx.db.query("DROP TRIGGER IF EXISTS fail_cancel_insert ON payment_cancels");
});
afterAll(async () => {
  await ctx.db.end();
  await toss.close();
});

const cancel = (key: string | undefined, body: object = {}) =>
  postJson(ctx.app, `/api/orders/${orderId}/cancel`, { cancelReason: "customer request", ...body }, key ? { "Idempotency-Key": key } : {});
const order = async () =>
  (
    await ctx.db.query(
      "SELECT o.status, p.balance_amount AS balance FROM orders o JOIN payments p USING (order_id) WHERE o.order_id = $1",
      [orderId],
    )
  ).rows[0];
const cancelCalls = () => toss.calls.filter((c) => c.endsWith("/cancel")).length;

describe("cancel", () => {
  it("partial cancel reduces the balance and sets PARTIALLY_CANCELED", async () => {
    const res = await cancel("c-1", { cancelAmount: 5000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "PARTIALLY_CANCELED", balanceAmount: 10000 });
    expect(await order()).toEqual({ status: "PARTIALLY_CANCELED", balance: 10000 });
    expect((await ctx.db.query("SELECT cancel_amount FROM payment_cancels")).rows).toEqual([{ cancel_amount: 5000 }]);
  });

  it("cancel without an amount cancels the remaining balance", async () => {
    await cancel("c-1", { cancelAmount: 5000 });
    const res = await cancel("c-2");
    expect(await res.json()).toMatchObject({ status: "CANCELED", balanceAmount: 0 });
    expect(await order()).toEqual({ status: "CANCELED", balance: 0 });
  });

  it("same cancel request sent twice reaches Toss once", async () => {
    const first = await (await cancel("c-1", { cancelAmount: 1000 })).json();
    const second = await (await cancel("c-1", { cancelAmount: 1000 })).json();
    expect(second).toEqual(first);
    expect(cancelCalls()).toBe(1);
    expect(await order()).toEqual({ status: "PARTIALLY_CANCELED", balance: 14000 });
  });

  it("reusing a cancel key with a different amount is rejected", async () => {
    await cancel("c-1", { cancelAmount: 1000 });
    const res = await cancel("c-1", { cancelAmount: 2000 });
    expect(res.status).toBe(422);
    expect(cancelCalls()).toBe(1);
  });

  it("two concurrent cancels never exceed the paid amount", async () => {
    toss.cancelDelayMs = 200; // keep the first cancel in flight while the second arrives
    const [a, b] = await Promise.all([cancel("c-a", { cancelAmount: 10000 }), cancel("c-b", { cancelAmount: 10000 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(cancelCalls()).toBe(1);
    expect(await order()).toEqual({ status: "PARTIALLY_CANCELED", balance: 5000 });
  });

  it("cancel above the balance is rejected with 0 Toss calls", async () => {
    const res = await cancel("c-1", { cancelAmount: 15001 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "EXCEEDS_BALANCE" });
    expect(cancelCalls()).toBe(0);
  });

  it("cancelAmount of 0, -1, 1.5 or text is rejected with 0 Toss calls", async () => {
    for (const cancelAmount of [0, -1, 1.5, "abc"]) {
      expect((await cancel(`c-${cancelAmount}`, { cancelAmount })).status).toBe(400);
    }
    expect(cancelCalls()).toBe(0);
  });

  it("cancel without an Idempotency-Key or of a PENDING order is rejected with 0 Toss calls", async () => {
    expect((await cancel(undefined, { cancelAmount: 1000 })).status).toBe(400);
    const pending = await (await postJson(ctx.app, "/api/orders", {})).json();
    const res = await postJson(ctx.app, `/api/orders/${pending.orderId}/cancel`, { cancelReason: "x" }, { "Idempotency-Key": "c-p" });
    expect(res.status).toBe(409);
    expect(cancelCalls()).toBe(0);
  });

  it("a Toss rejection marks the cancel FAILED and frees the order for a new cancel", async () => {
    // Toss knows a smaller balance than we do (for example a cancel made in the Toss dashboard).
    (toss.payments["pk-c"] as { balanceAmount: number }).balanceAmount = 1000;
    expect((await cancel("c-1", { cancelAmount: 5000 })).status).toBe(502);
    const again = await cancel("c-1", { cancelAmount: 5000 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "NOT_CANCELABLE_AMOUNT" });
    expect((await cancel("c-2", { cancelAmount: 1000 })).status).toBe(200);
  });

  it("recovery does not replay a cancel older than the Toss key window", async () => {
    await ctx.db.query(
      `INSERT INTO cancel_requests (order_id, request_key, payment_key, cancel_amount, cancel_reason, created_at)
       VALUES ($1, 'c-old', 'pk-c', 1000, 'x', now() - interval '15 days')`,
      [orderId],
    );
    expect(await recoverCancelRequests(ctx.db, 0)).toEqual([{ orderId, requestKey: "c-old", result: "too_old_for_replay" }]);
    expect(cancelCalls()).toBe(0);
    // It still blocks new cancels until a person resolves it (ADR 0003).
    expect((await cancel("c-new", { cancelAmount: 1000 })).status).toBe(409);
  });

  it("cancel that succeeded at Toss but failed in the DB is repaired by replaying the same key", async () => {
    await ctx.db.query(`
      CREATE OR REPLACE FUNCTION fail_cancel_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated write failure'; END $$ LANGUAGE plpgsql`);
    await ctx.db.query(
      "CREATE TRIGGER fail_cancel_insert BEFORE INSERT ON payment_cancels FOR EACH ROW EXECUTE FUNCTION fail_cancel_insert()",
    );
    expect((await cancel("c-1", { cancelAmount: 3000 })).status).toBe(500);
    expect(await order()).toEqual({ status: "PAID", balance: 15000 });
    await ctx.db.query("DROP TRIGGER fail_cancel_insert ON payment_cancels");

    expect(await recoverCancelRequests(ctx.db, 0)).toEqual([{ orderId, requestKey: "c-1", result: "done" }]);
    expect(await order()).toEqual({ status: "PARTIALLY_CANCELED", balance: 12000 });
    // Two calls with one key, one cancel applied at Toss.
    expect(cancelCalls()).toBe(2);
    expect(toss.appliedCancels).toBe(1);
    expect(new Set(toss.idempotencyKeys.filter((k) => k?.startsWith("cancel-"))).size).toBe(1);
  });
});
