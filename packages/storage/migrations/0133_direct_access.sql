-- Direct access on `.com` (docs/direct-access-and-domains.md §6 step 3): the owner's signed direct-access orders,
-- the boxes' signed address updates, the direct-name registry on the direct domain (`fshp.app`), and the `direct`
-- certificate class. Re-runnable: CREATE ... IF NOT EXISTS, and a guarded rebuild for certificate_orders.

-- The newest owner-signed `flagship/direct-access/v1` order per box (kept when turned off: its issued_at is the
-- replay floor), and the newest box-signed `flagship/direct-address/v1` update inside it. `order_sha256` is what an
-- update must name; a new order clears the update.
CREATE TABLE IF NOT EXISTS direct_access_orders (
  server_domain        TEXT PRIMARY KEY,
  username             TEXT NOT NULL,
  order_json           TEXT NOT NULL,
  signature_hex        TEXT NOT NULL,
  pq_signature_json    TEXT,
  order_sha256         TEXT NOT NULL CHECK (length(order_sha256) = 64),
  enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  issued_at            INTEGER NOT NULL,
  update_json          TEXT,
  update_signature_hex TEXT,
  update_issued_at     INTEGER,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_direct_access_user ON direct_access_orders(username);

-- One row per name on the direct domain. `name` is the label (`game--john-doe`); the owner's newest signed
-- `flagship/direct-name/v1` order decides it (kept when turned off: the replay floor). `published_json` is what the
-- zone holds now (`[{type, content}]`), `publish_state` whether that matches what the rows say it should
-- ('pending' = reconcile, 'published', 'empty' = nothing to publish). `suspended_*` is the abuse lever (the record
-- is withdrawn while set). `probe_json` is the last outside reachability check (a diagnostic, never a gate).
CREATE TABLE IF NOT EXISTS direct_names (
  name                 TEXT PRIMARY KEY,
  username             TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('derived', 'vanity')),
  server_domain        TEXT NOT NULL,
  enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  order_json           TEXT NOT NULL,
  signature_hex        TEXT NOT NULL,
  pq_signature_json    TEXT,
  issued_at            INTEGER NOT NULL,
  suspended_at         INTEGER,
  suspended_reason     TEXT,
  published_json       TEXT NOT NULL DEFAULT '[]',
  publish_state        TEXT NOT NULL DEFAULT 'pending' CHECK (publish_state IN ('pending', 'published', 'empty')),
  publish_reason       TEXT,
  publish_error        TEXT,
  published_at         INTEGER,
  probe_at             INTEGER,
  probe_json           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_direct_names_user ON direct_names(username);
CREATE INDEX IF NOT EXISTS idx_direct_names_server ON direct_names(server_domain);
CREATE INDEX IF NOT EXISTS idx_direct_names_state ON direct_names(publish_state, updated_at);

-- certificate_orders takes the `direct` class: SQLite can't change a CHECK in place, so the table is rebuilt.
CREATE TABLE IF NOT EXISTS certificate_orders_v2 (
  order_id          TEXT PRIMARY KEY CHECK (length(order_id) = 32),
  request_id        TEXT NOT NULL,
  device_pub        TEXT NOT NULL CHECK (length(device_pub) = 64),
  username          TEXT NOT NULL,
  server_domain     TEXT,
  class             TEXT NOT NULL CHECK (class IN ('control', 'apps', 'phone', 'direct')),
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
INSERT INTO certificate_orders_v2
  SELECT order_id, request_id, device_pub, username, server_domain, class, reg_gen, names, zone, csr_b64, csr_spki_sha256,
         order_json, signature, status, step, acme_order_url, acme_json, published_at, acme_ordered_at, chain_pem,
         not_before, not_after, error_code, error, lock_until, created_at, updated_at
  FROM certificate_orders
  WHERE NOT EXISTS (SELECT 1 FROM certificate_orders_v2);
DROP TABLE IF EXISTS certificate_orders;
ALTER TABLE certificate_orders_v2 RENAME TO certificate_orders;
CREATE INDEX IF NOT EXISTS idx_cert_orders_device ON certificate_orders(device_pub, class, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_names ON certificate_orders(names, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_zone ON certificate_orders(zone, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_ordered ON certificate_orders(acme_ordered_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_user ON certificate_orders(username, created_at);
CREATE INDEX IF NOT EXISTS idx_cert_orders_pending ON certificate_orders(status, updated_at);
