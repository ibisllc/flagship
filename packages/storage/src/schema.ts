/**
 * The full SQLite/D1 schema for the Flagship .com control plane.
 * Used to seed the D1 database via `wrangler d1 execute`.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usernames (
  username TEXT PRIMARY KEY,
  irk_pub_hex TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  serial TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  server_name TEXT NOT NULL,
  server_domain TEXT NOT NULL,
  delegated_pubkey_hex TEXT NOT NULL,
  user_pubkey_hex TEXT NOT NULL,
  user_signature_hex TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'used', 'revoked')),
  recorded_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_username ON auth_codes(username);
CREATE INDEX IF NOT EXISTS idx_auth_codes_status ON auth_codes(status);

-- build_tickets table removed (QR-pipe is the only flow now; .com no
-- longer stores signed blobs at rest). Pre-existing prod rows are
-- ignored. A future migration may DROP TABLE — for now we just stop
-- creating it on fresh deploys.

CREATE TABLE IF NOT EXISTS servers (
  server_domain TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  identity_pubkey_hex TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_servers_username ON servers(username);

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

CREATE TABLE IF NOT EXISTS user_identity_records (
  username_hash TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  authorized_signers_json TEXT NOT NULL,
  blob_version INTEGER NOT NULL,
  signature_hex TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
