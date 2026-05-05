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

CREATE TABLE IF NOT EXISTS build_tickets (
  code TEXT PRIMARY KEY,
  blob_json TEXT NOT NULL,
  blob_signature_hex TEXT NOT NULL,
  username TEXT NOT NULL,
  server_domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'redeemed', 'revoked')),
  redeemed_at INTEGER,
  redemptions INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_build_tickets_username ON build_tickets(username);

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
`;
