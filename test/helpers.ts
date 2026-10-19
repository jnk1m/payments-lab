import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { createDb, type Db } from "../src/db.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
export const paymentDone = fixture("payment-done.json");
export const transactions = fixture("transactions.json");

// A local HTTP server that answers like the Toss API, using recorded-format fixtures.
// The app under test talks to it with its real HTTP client.
export type FakeToss = {
  calls: string[];
  payments: Record<string, unknown>;
  transactions: unknown[];
  rejectConfirm: boolean;
  failLookup: boolean;
  confirmDelayMs: number;
  idempotencyKeys: (string | undefined)[];
  close(): Promise<void>;
};

export async function startFakeToss(): Promise<FakeToss> {
  const state: FakeToss = {
    calls: [],
    payments: {},
    transactions: [],
    rejectConfirm: false,
    failLookup: false,
    confirmDelayMs: 0,
    idempotencyKeys: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      state.calls.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url.pathname === "/v1/payments/confirm") {
        state.idempotencyKeys.push(req.headers["idempotency-key"] as string | undefined);
        if (state.rejectConfirm) return send(400, { code: "REJECT_CARD_COMPANY", message: "card rejected" });
        const body = JSON.parse(raw);
        // Toss keeps the approval, so a later lookup finds it even if our side never stored it.
        const approved = { ...paymentDone, paymentKey: body.paymentKey, orderId: body.orderId, totalAmount: body.amount };
        state.payments[body.paymentKey] = approved;
        const reply = () => send(200, approved);
        return state.confirmDelayMs ? void setTimeout(reply, state.confirmDelayMs) : reply();
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/payments/orders/")) {
        const orderId = decodeURIComponent(url.pathname.split("/").pop()!);
        const found = Object.values(state.payments).find((p) => (p as { orderId: string }).orderId === orderId);
        return found ? send(200, found) : send(404, { code: "NOT_FOUND_PAYMENT", message: "not found" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/payments/")) {
        if (state.failLookup) return send(500, { code: "FAILED_INTERNAL_SYSTEM_PROCESSING", message: "down" });
        const found = state.payments[decodeURIComponent(url.pathname.split("/").pop()!)];
        return found ? send(200, found) : send(404, { code: "NOT_FOUND_PAYMENT", message: "not found" });
      }
      if (req.method === "GET" && url.pathname === "/v1/transactions") {
        return send(200, url.searchParams.has("startingAfter") ? [] : state.transactions);
      }
      send(404, { code: "NOT_FOUND", message: url.pathname });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.TOSS_API_BASE = `http://localhost:${(server.address() as AddressInfo).port}`;
  return state;
}

export async function startApp(): Promise<{ db: Db; app: ReturnType<typeof createApp> }> {
  process.env.DATABASE_URL ??= "postgres://payments:payments@localhost:5433/payments";
  process.env.TOSS_CLIENT_KEY = "test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm";
  process.env.TOSS_SECRET_KEY = "test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6";
  const db = createDb();
  await db.query("TRUNCATE webhook_events, payments, orders CASCADE");
  return { db, app: createApp(db) };
}

export const postJson = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
