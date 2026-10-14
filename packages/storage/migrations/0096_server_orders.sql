-- The owner's server order (docs/server-order.md): one row per account, the
-- newest signed order. `.com` verifies it before storing and serves it on
-- /pods and in the daemon-status reply. Re-runnable.
CREATE TABLE IF NOT EXISTS server_orders (
  username TEXT PRIMARY KEY,
  order_json TEXT NOT NULL,
  signature_hex TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);
