// Sends a PAYMENT_STATUS_CHANGED webhook to the local server in the format from the Toss docs.
// Toss cannot reach localhost, so this replaces the real delivery.
process.loadEnvFile();
const [paymentKey, orderId, id = crypto.randomUUID()] = process.argv.slice(2);
if (!paymentKey || !orderId) {
  console.error("Usage: npm run webhook:send -- <paymentKey> <orderId> [transmissionId]");
  process.exit(2);
}

const res = await fetch(`http://localhost:${process.env.PORT ?? 3000}/webhooks/toss`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "tosspayments-webhook-transmission-id": id,
    "tosspayments-webhook-transmission-retried-count": "0",
    "tosspayments-webhook-transmission-time": new Date().toISOString(),
  },
  body: JSON.stringify({
    eventType: "PAYMENT_STATUS_CHANGED",
    createdAt: new Date().toISOString().replace("Z", "000"),
    data: { paymentKey, orderId },
  }),
});
console.log(res.status, await res.text());
