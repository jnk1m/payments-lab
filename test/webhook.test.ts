import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeToss, paymentDone, postJson, startApp, startFakeToss } from "./helpers.js";

let toss: FakeToss;
let ctx: Awaited<ReturnType<typeof startApp>>;
let orderId: string;

beforeAll(async () => {
  toss = await startFakeToss();
});
beforeEach(async () => {
  ctx = await startApp();
  toss.calls.length = 0;
  toss.failLookup = false;
  const order = await (await postJson(ctx.app, "/api/orders", {})).json();
  orderId = order.orderId;
  await postJson(ctx.app, "/api/payments/confirm", { paymentKey: "pk-w", orderId, amount: order.amount });
  toss.calls.length = 0;
});
afterAll(async () => {
  await ctx.db.end();
  await toss.close();
});

const send = (id: string, data: object = { paymentKey: "pk-w", orderId }) =>
  postJson(
    ctx.app,
    "/webhooks/toss",
    { eventType: "PAYMENT_STATUS_CHANGED", createdAt: "2026-10-18T12:00:00.000000", data },
    { "tosspayments-webhook-transmission-id": id },
  );
const paymentStatus = async () =>
  (await ctx.db.query("SELECT status FROM payments WHERE payment_key = 'pk-w'")).rows[0].status;

describe("webhook", () => {
  it("takes the status from the lookup API, not from the webhook body", async () => {
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "CANCELED" };
    // The body claims DONE. The lookup says CANCELED, and CANCELED wins.
    const res = await send("t-1", { paymentKey: "pk-w", orderId, status: "DONE" });
    expect(await res.json()).toEqual({ result: "applied" });
    expect(await paymentStatus()).toBe("CANCELED");
    expect(toss.calls).toEqual(["GET /v1/payments/pk-w"]);
  });

  it("applies the same delivery once when it is received 3 times", async () => {
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "CANCELED" };
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await (await send("t-2")).json()).result);
    expect(results).toEqual(["applied", "duplicate", "duplicate"]);
    expect(toss.calls).toEqual(["GET /v1/payments/pk-w"]);
    expect((await ctx.db.query("SELECT 1 FROM webhook_events")).rowCount).toBe(1);
  });

  it("returns 500 and leaves no event row when the lookup fails, so a retry is processed", async () => {
    toss.failLookup = true;
    const failed = await send("t-3");
    expect(failed.status).toBe(500);
    expect((await ctx.db.query("SELECT 1 FROM webhook_events")).rowCount).toBe(0);

    toss.failLookup = false;
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "CANCELED" };
    const retry = await send("t-3");
    expect(await retry.json()).toEqual({ result: "applied" });
    expect(await paymentStatus()).toBe("CANCELED");
  });

  it("webhook that arrives before confirm is not lost", async () => {
    const early = await (await postJson(ctx.app, "/api/orders", {})).json();
    // Toss approved and sent the webhook before our confirm committed.
    toss.payments["pk-early"] = { ...paymentDone, paymentKey: "pk-early", orderId: early.orderId, totalAmount: early.amount };
    const res = await send("t-5", { paymentKey: "pk-early", orderId: early.orderId });
    expect(await res.json()).toEqual({ result: "applied" });
    const order = await ctx.db.query("SELECT status FROM orders WHERE order_id = $1", [early.orderId]);
    expect(order.rows[0].status).toBe("PAID");

    // The browser's confirm arrives afterwards and gets the stored payment without a second approval.
    toss.calls.length = 0;
    const confirm = await postJson(ctx.app, "/api/payments/confirm", { paymentKey: "pk-early", orderId: early.orderId, amount: early.amount });
    expect(confirm.status).toBe(200);
    expect(toss.calls).toEqual([]);
  });

  it("unknown_payment webhook does not consume the transmission id", async () => {
    toss.payments["pk-unknown"] = { ...paymentDone, paymentKey: "pk-unknown", status: "DONE" };
    expect(await (await send("t-6", { paymentKey: "pk-unknown" })).json()).toEqual({ result: "unknown_payment" });
    expect((await ctx.db.query("SELECT 1 FROM webhook_events WHERE transmission_id = 't-6'")).rowCount).toBe(0);
    // A retry of the same delivery is looked at again, not dropped as a duplicate.
    expect(await (await send("t-6", { paymentKey: "pk-unknown" })).json()).toEqual({ result: "unknown_payment" });
  });

  it("older lookup result cannot overwrite a newer status when two webhooks race", async () => {
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "CANCELED", balanceAmount: 0 };
    await send("t-7");
    // A second delivery whose lookup ran earlier and still saw DONE is processed last.
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "DONE", balanceAmount: 15000 };
    expect(await (await send("t-8")).json()).toEqual({ result: "stale" });
    expect(await paymentStatus()).toBe("CANCELED");
    const order = await ctx.db.query("SELECT status FROM orders WHERE order_id = $1", [orderId]);
    expect(order.rows[0].status).toBe("CANCELED");
  });

  it("a late approval webhook never moves a canceled order back to PAID", async () => {
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "PARTIAL_CANCELED", balanceAmount: 5000 };
    await send("t-9");
    toss.payments["pk-w"] = { ...paymentDone, paymentKey: "pk-w", orderId, status: "DONE", balanceAmount: 15000 };
    await send("t-10");
    const row = await ctx.db.query(
      "SELECT o.status, p.balance_amount FROM orders o JOIN payments p USING (order_id) WHERE o.order_id = $1",
      [orderId],
    );
    expect(row.rows[0]).toEqual({ status: "PARTIALLY_CANCELED", balance_amount: 5000 });
  });

  it("returns 200 and changes nothing for a payment we do not know", async () => {
    toss.payments["pk-unknown"] = { ...paymentDone, paymentKey: "pk-unknown", status: "CANCELED" };
    const res = await send("t-4", { paymentKey: "pk-unknown" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "unknown_payment" });
    expect(await paymentStatus()).toBe("DONE");
  });
});
