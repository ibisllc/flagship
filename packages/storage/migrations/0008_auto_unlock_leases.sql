-- Auto-unlock leases — IRK-signed envelopes that authorise .com to
-- release the LUKS unlock key when a server polls /unlock-key/consume.
--
-- Two modes share the same row shape:
--   * multi_use=0 → behaves like the existing unlock_key_deposits row:
--       first /consume returns the key, the row is deleted (one-shot).
--   * multi_use=1 → persists across consumes until expires_at, so the
--       server can reboot freely while the lease is live (the
--       "out-and-about" mode).
--
-- (server_domain, lease_id) is the primary key — multiple long-lived
-- leases can coexist for the same server (e.g. user's phone AND webapp
-- both signed). Each is independently revocable by lease_id.
CREATE TABLE IF NOT EXISTS auto_unlock_leases (
  server_domain TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  unlock_key_hex TEXT NOT NULL,
  multi_use INTEGER NOT NULL,         -- 0 or 1
  deposited_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (server_domain, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_auto_unlock_leases_server
  ON auto_unlock_leases(server_domain);
CREATE INDEX IF NOT EXISTS idx_auto_unlock_leases_expiry
  ON auto_unlock_leases(expires_at);
