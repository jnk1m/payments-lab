import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/reconcile.js";
import { type FakeToss, startApp, startFakeToss, transactions } from "./helpers.js";

let toss: FakeToss;
let ctx: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  toss = await startFakeToss();
});
beforeEach(async () => {
  ctx = await startApp();
  toss.transactions = transactions;
});
afterAll(async () => {
  await ctx.db.end();
  await toss.close();
});

async function seed(key: string, amount: number, status: string, approvedAt: string) {
  const orderId = `o-${key}`;
  await ctx.db.query("INSERT INTO orders (order_id, order_name, amount, status) VALUES ($1, 'x', $2, 'PAID')", [orderId, amount]);
  await ctx.db.query(
    "INSERT INTO payments (payment_key, order_id, amount, status, approved_at) VALUES ($1, $2, $3, $4, $5)",
    [key, orderId, amount, status, approvedAt],
  );
}

const from = "2026-10-18T00:00:00";
const to = "2026-10-18T23:59:59";

describe("reconcile", () => {
  it("reports one item for each kind of mismatch and nothing for matching payments", async () => {
    await seed("pk-ok", 15000, "DONE", "2026-10-18T10:00:05+09:00");
    await seed("pk-amount", 14000, "DONE", "2026-10-18T10:05:00+09:00");
    await seed("pk-status", 15000, "DONE", "2026-10-18T10:10:00+09:00");
    await seed("pk-only-db", 7000, "DONE", "2026-10-18T13:00:00+09:00");
    // pk-only-toss exists only in the Toss fixture

    const result = await reconcile(ctx.db, from, to);
    expect(result.map((m) => [m.kind, m.paymentKey]).sort()).toEqual([
      ["AMOUNT_MISMATCH", "pk-amount"],
      ["MISSING_AT_TOSS", "pk-only-db"],
      ["MISSING_IN_DB", "pk-only-toss"],
      ["STATUS_MISMATCH", "pk-status"],
    ]);
  });

  it("reports nothing when both sides agree", async () => {
    toss.transactions = [transactions[0]];
    await seed("pk-ok", 15000, "DONE", "2026-10-18T10:00:05+09:00");
    expect(await reconcile(ctx.db, from, to)).toEqual([]);
  });

  it("ignores local payments outside the period", async () => {
    toss.transactions = [];
    await seed("pk-old", 15000, "DONE", "2026-10-10T10:00:00+09:00");
    expect(await reconcile(ctx.db, from, to)).toEqual([]);
  });
});
