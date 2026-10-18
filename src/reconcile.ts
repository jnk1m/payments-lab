import type { Db } from "./db.js";
import { toss, type TossTransaction } from "./toss.js";

export type Mismatch = {
  kind: "MISSING_IN_DB" | "MISSING_AT_TOSS" | "AMOUNT_MISMATCH" | "STATUS_MISMATCH";
  paymentKey: string;
  detail: string;
};

type Side = { amount: number; status: string };

// from and to: yyyy-MM-dd'T'HH:mm:ss in KST, the same format the Toss transactions API takes.
export async function reconcile(db: Db, from: string, to: string): Promise<Mismatch[]> {
  const transactions = await toss.listTransactions(from, to);
  const remote = summarize(transactions);

  const { rows } = await db.query<{ payment_key: string; amount: number; status: string }>(
    "SELECT payment_key, amount, status FROM payments WHERE approved_at >= $1 AND approved_at <= $2",
    [`${from}+09:00`, `${to}+09:00`],
  );
  const local = new Map<string, Side>(rows.map((r) => [r.payment_key, { amount: r.amount, status: r.status }]));

  const out: Mismatch[] = [];
  for (const [key, r] of remote) {
    const l = local.get(key);
    if (!l) out.push({ kind: "MISSING_IN_DB", paymentKey: key, detail: `Toss has ${r.amount} ${r.status}` });
    else if (l.amount !== r.amount)
      out.push({ kind: "AMOUNT_MISMATCH", paymentKey: key, detail: `db ${l.amount}, toss ${r.amount}` });
    else if (l.status !== r.status)
      out.push({ kind: "STATUS_MISMATCH", paymentKey: key, detail: `db ${l.status}, toss ${r.status}` });
  }
  for (const [key, l] of local) {
    if (!remote.has(key)) out.push({ kind: "MISSING_AT_TOSS", paymentKey: key, detail: `db has ${l.amount} ${l.status}` });
  }
  return out;
}

// A payment can have several transactions (approval, then cancels).
// Amount is the approval amount (first transaction), status is the latest one.
function summarize(transactions: TossTransaction[]): Map<string, Side> {
  const byPayment = new Map<string, TossTransaction[]>();
  for (const t of transactions) byPayment.set(t.paymentKey, [...(byPayment.get(t.paymentKey) ?? []), t]);

  const result = new Map<string, Side>();
  for (const [key, list] of byPayment) {
    list.sort((a, b) => a.transactionAt.localeCompare(b.transactionAt));
    result.set(key, { amount: list[0]!.amount, status: list.at(-1)!.status });
  }
  return result;
}
