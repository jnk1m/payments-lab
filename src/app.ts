import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { AmountMismatchError, UnknownOrderError, confirmPayment, createOrder } from "./payments.js";
import { TossError } from "./toss.js";
import { handleWebhook, type WebhookBody } from "./webhook.js";

const page = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

export function createApp(db: Db) {
  const app = new Hono();

  app.get("/", async (c) => c.html((await page("index.html")).replace("__CLIENT_KEY__", config.clientKey())));
  app.get("/success", async (c) => c.html(await page("success.html")));
  app.get("/fail", async (c) => c.html(await page("fail.html")));

  app.post("/api/orders", async (c) => c.json(await createOrder(db)));

  app.post("/api/payments/confirm", async (c) => {
    const { paymentKey, orderId, amount } = await c.req.json();
    try {
      return c.json(await confirmPayment(db, { paymentKey, orderId, amount: Number(amount) }));
    } catch (err) {
      if (err instanceof AmountMismatchError) return c.json({ code: "AMOUNT_MISMATCH", message: err.message }, 400);
      if (err instanceof UnknownOrderError) return c.json({ code: "UNKNOWN_ORDER", message: err.message }, 404);
      if (err instanceof TossError) return c.json({ code: err.code, message: err.message }, 502);
      throw err;
    }
  });

  app.post("/webhooks/toss", async (c) => {
    const body = (await c.req.json()) as WebhookBody;
    const transmissionId = c.req.header("tosspayments-webhook-transmission-id");
    if (!transmissionId) return c.json({ code: "MISSING_TRANSMISSION_ID" }, 400);
    // Any thrown error becomes a 500, which makes Toss retry the delivery.
    return c.json({ result: await handleWebhook(db, transmissionId, body) });
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ code: "INTERNAL", message: err.message }, 500);
  });

  return app;
}
