import { createDb } from "../src/db.js";
import { recoverPendingOrders } from "../src/recovery.js";

process.loadEnvFile();
const graceSeconds = Number(process.argv[2] ?? 600);
if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
  console.error("Usage: npm run recover -- [graceSeconds, default 600]");
  process.exit(2);
}

const db = createDb();
const results = await recoverPendingOrders(db, graceSeconds);
await db.end();

for (const r of results) console.log(`${r.result}\t${r.orderId}`);
if (results.length === 0) console.log(`OK: no PENDING orders older than ${graceSeconds}s`);
process.exit(results.some((r) => r.result === "amount_mismatch") ? 1 : 0);
