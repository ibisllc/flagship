-- The certificate issuance service (plan H1/H9/H7; docs/architecture-v2/issuance-service.md).
-- Re-runnable: CREATE ... IF NOT EXISTS only.

-- One row per device request. `names` is the sorted name list joined by "\n"; `zone` is `<user>.<apex>`, the
-- registered domain Let's Encrypt counts. `acme_ordered_at` is set once the CA saw the order (it counts against the
-- service's order budget from then on). `acme_json` keeps the order's authorizations, challenges and DNS record ids.
CREATE TABLE IF NOT EXISTS certificate_orders (
  order_id          TEXT PRIMARY KEY CHECK (length(order_id) = 32),
  request_id        TEXT NOT NULL,
  device_pub        TEXT NOT NULL CHECK (length(device_pub) = 64),
  username          TEXT NOT NULL,
  server_domain     TEXT,
  class             TEXT NOT NULL CHECK (class IN ('control', 'apps', 'phone')),
  reg_gen           INTEGER NOT NULL,
  names             TEXT NOT NULL,
  zone              TEXT NOT NULL,
  csr_b64           TEXT NOT NULL,
  csr_spki_sha256   TEXT NOT NULL,
  order_json        TEXT NOT NULL,
  signature         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'issued', 'failed')),
  step              TEXT NOT NULL,
  acme_order_url    TEXT,
  acme_json         TEXT,
  published_at      INTEGER,
  acme_ordered_at   INTEGER,
  chain_pem         TEXT,
  not_before        INTEGER,
  not_after         INTEGER,
  error_code        TEXT,
  error             TEXT,
  lock_until        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (device_pub, request_id)
);
CREATE INDEX IF NOT EXISTS idx_cert_orders_device ON certificate_orders(device_pub, class, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_names ON certificate_orders(names, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_zone ON certificate_orders(zone, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_ordered ON certificate_orders(acme_ordered_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_user ON certificate_orders(username, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_pending ON certificate_orders(status, updated_at);

-- The service's ACME account URL per directory and key (found or created on first use; the apex CAA pins it).
CREATE TABLE IF NOT EXISTS issuance_acme_accounts (
  directory    TEXT NOT NULL,
  thumbprint   TEXT NOT NULL,
  account_url  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (directory, thumbprint)
);

-- A `rateLimited` answer from the CA stops every order until `until`.
CREATE TABLE IF NOT EXISTS issuance_backoff (
  scope    TEXT PRIMARY KEY,
  until    INTEGER NOT NULL,
  reason   TEXT
);

-- Certificates to revoke at the CA: issued after a revocation won the race, or a chain that failed its check.
CREATE TABLE IF NOT EXISTS certificate_revocations (
  order_id      TEXT PRIMARY KEY,
  leaf_b64      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'revoked', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cert_revocations_status ON certificate_revocations(status, updated_at);
