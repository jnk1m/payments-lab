import { createDb } from "../src/db.js";
import { recoverCancelRequests, recoverPendingOrders } from "../src/recovery.js";

process.loadEnvFile();
const graceSeconds = Number(process.argv[2] ?? 600);
if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
  console.error("Usage: npm run recover -- [graceSeconds, default 600]");
  process.exit(2);
}

const db = createDb();
const orders = await recoverPendingOrders(db, graceSeconds);
const cancels = await recoverCancelRequests(db, graceSeconds);
await db.end();

for (const r of orders) console.log(`order\t${r.result}\t${r.orderId}${r.error ? `\t${r.error}` : ""}`);
for (const r of cancels) console.log(`cancel\t${r.result}\t${r.orderId}\t${r.requestKey}${r.error ? `\t${r.error}` : ""}`);
if (orders.length + cancels.length === 0) console.log(`OK: nothing to recover older than ${graceSeconds}s`);
// Needs a person: an amount that does not match, a cancel too old to replay safely, or an unexpected error.
const needsPerson =
  orders.some((r) => r.result === "amount_mismatch" || r.result === "error") ||
  cancels.some((r) => r.result === "too_old_for_replay" || r.result === "error");
process.exit(needsPerson ? 1 : 0);
