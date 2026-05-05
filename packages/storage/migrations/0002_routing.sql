CREATE TABLE IF NOT EXISTS routing (
  subdomain TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  rck_pubkey_hex TEXT NOT NULL,
  current_target_hex TEXT NOT NULL DEFAULT '',
  registered_at INTEGER NOT NULL,
  last_target_update INTEGER NOT NULL DEFAULT 0,
  last_target_nonce TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_routing_username ON routing(username);
CREATE INDEX IF NOT EXISTS idx_routing_target ON routing(current_target_hex);
