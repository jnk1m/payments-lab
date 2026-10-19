import { config } from "./config.js";

export type TossPayment = {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  approvedAt: string;
};

export type TossTransaction = {
  transactionKey: string;
  paymentKey: string;
  orderId: string;
  status: string;
  amount: number;
  transactionAt: string;
};

export class TossError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    message: string,
    context: string,
  ) {
    super(`Toss ${context} failed: ${httpStatus} ${code} ${message}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const auth = Buffer.from(`${config.secretKey()}:`).toString("base64");
  const res = await fetch(`${config.apiBase()}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65_000), // transactions API can take up to 60s
  });
  const json = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) {
    throw new TossError(res.status, json.code ?? "UNKNOWN", json.message ?? "", `${method} ${path}`);
  }
  return json;
}

export const toss = {
  // Toss documents that a POST repeated with the same Idempotency-Key within 15 days gets the first
  // response, so a retry after a timeout should not approve twice. Keyed by paymentKey, so a new attempt
  // gets a new key. Verified on cancel with the docs test key; not replayed on confirm.
  confirm: (input: { paymentKey: string; orderId: string; amount: number }) =>
    call<TossPayment>("POST", "/v1/payments/confirm", input, { "Idempotency-Key": `confirm-${input.paymentKey}` }),

  getPayment: (paymentKey: string) =>
    call<TossPayment>("GET", `/v1/payments/${encodeURIComponent(paymentKey)}`),

  // Used by recovery, when we may never have seen the paymentKey.
  getPaymentByOrderId: (orderId: string) =>
    call<TossPayment>("GET", `/v1/payments/orders/${encodeURIComponent(orderId)}`),

  // startDate and endDate use yyyy-MM-dd'T'HH:mm:ss. Pages by transactionKey.
  async listTransactions(startDate: string, endDate: string): Promise<TossTransaction[]> {
    const all: TossTransaction[] = [];
    const limit = 1000;
    for (;;) {
      const q = new URLSearchParams({ startDate, endDate, limit: String(limit) });
      const last = all.at(-1);
      if (last) q.set("startingAfter", last.transactionKey);
      const page = await call<TossTransaction[]>("GET", `/v1/transactions?${q}`);
      all.push(...page);
      if (page.length < limit) return all;
    }
  },
};
