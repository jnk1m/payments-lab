CREATE TABLE IF NOT EXISTS orders (
  order_id   text PRIMARY KEY,
  order_name text NOT NULL,
  amount     integer NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  payment_key text PRIMARY KEY,
  order_id    text NOT NULL UNIQUE REFERENCES orders (order_id),
  amount      integer NOT NULL,
  status      text NOT NULL,
  approved_at timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per webhook delivery id, so a retried delivery is applied once.
CREATE TABLE IF NOT EXISTS webhook_events (
  transmission_id text PRIMARY KEY,
  payment_key     text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);
