CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
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
