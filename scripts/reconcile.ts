import { createDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";

process.loadEnvFile();
const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("Usage: npm run reconcile -- 2026-10-17T00:00:00 2026-10-17T23:59:59");
  process.exit(2);
}

const db = createDb();
const mismatches = await reconcile(db, from, to);
await db.end();

if (mismatches.length === 0) console.log(`OK: no mismatches from ${from} to ${to}`);
for (const m of mismatches) console.log(`${m.kind}\t${m.paymentKey}\t${m.detail}`);
process.exit(mismatches.length === 0 ? 0 : 1);
