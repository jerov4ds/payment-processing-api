CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  api_client_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  payment_method JSONB NOT NULL,
  status_reason TEXT,
  failure_reason TEXT,
  attempts INTEGER NOT NULL,
  version INTEGER NOT NULL,
  processing_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  api_client_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments (id),
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (api_client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS payments_status_created_idx
  ON payments (status, created_at DESC, id);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS api_client_id TEXT;

UPDATE payments AS payment
SET api_client_id = idempotency.api_client_id
FROM idempotency_keys AS idempotency
WHERE payment.id = idempotency.payment_id
  AND payment.api_client_id IS NULL;

DELETE FROM payments WHERE api_client_id IS NULL;

ALTER TABLE payments ALTER COLUMN api_client_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS payments_client_created_idx
  ON payments (api_client_id, created_at DESC, id);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
