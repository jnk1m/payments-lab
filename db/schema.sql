CREATE TABLE IF NOT EXISTS orders (
  order_id   text PRIMARY KEY,
  order_name text NOT NULL,
  amount     integer NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'PENDING'
             CHECK (status IN ('PENDING', 'PAID', 'PARTIALLY_CANCELED', 'CANCELED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  payment_key    text PRIMARY KEY,
  order_id       text NOT NULL UNIQUE REFERENCES orders (order_id),
  amount         integer NOT NULL,
  balance_amount integer NOT NULL,
  status         text NOT NULL,
  approved_at    timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (balance_amount >= 0 AND balance_amount <= amount)
);

-- One row per cancel transaction Toss reports. Insert only, never updated.
CREATE TABLE IF NOT EXISTS payment_cancels (
  transaction_key text PRIMARY KEY,
  payment_key     text NOT NULL REFERENCES payments (payment_key),
  cancel_amount   integer NOT NULL CHECK (cancel_amount > 0),
  canceled_at     timestamptz NOT NULL
);

-- A cancel we intend to send, written before calling Toss. At most one REQUESTED row per order;
-- recovery replays it with the same idempotency key.
CREATE TABLE IF NOT EXISTS cancel_requests (
  order_id      text NOT NULL REFERENCES orders (order_id),
  request_key   text NOT NULL,
  payment_key   text NOT NULL REFERENCES payments (payment_key),
  cancel_amount integer NOT NULL CHECK (cancel_amount > 0),
  cancel_reason text NOT NULL,
  status        text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'DONE', 'FAILED')),
  error_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, request_key)
);

-- One row per webhook delivery id, so a retried delivery is applied once.
CREATE TABLE IF NOT EXISTS webhook_events (
  transmission_id text PRIMARY KEY,
  payment_key     text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
