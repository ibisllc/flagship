-- Peer backup between accounts (docs/peer-backup.md §13).
--
-- pb_holders: one row per server that holds bricks for others. The PIK is a
-- random key the box made, not derived from the account. row_json carries
-- the pool size, opaque account/network tags (HMACs: no username or address
-- in clear beyond the columns below), the presence ring, filler count, the
-- pending filler challenge and decayed proof counts.
-- pb_leases: space a holder was paid for with blind tokens, per its own
-- lease id. Nothing here names the owner: the tokens are unlinkable.
-- pb_token_serials: SHA-256 of every spent token serial (double spends).
-- pb_token_issue: how many tokens each server got, for its 30-day allowance.
-- pb_roots: the sealed record a restore starts from; the newest 8 per server.

CREATE TABLE IF NOT EXISTS pb_holders (
  pik_pub_hex     TEXT PRIMARY KEY,
  server_domain   TEXT NOT NULL UNIQUE,
  username        TEXT NOT NULL,
  last_checkin_at INTEGER NOT NULL,
  row_json        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pb_leases (
  pik_pub_hex TEXT NOT NULL,
  lease_id    TEXT NOT NULL,
  slots       INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (pik_pub_hex, lease_id)
);
CREATE INDEX IF NOT EXISTS idx_pb_leases_pik ON pb_leases(pik_pub_hex, expires_at);

CREATE TABLE IF NOT EXISTS pb_token_serials (
  serial_sha256 TEXT PRIMARY KEY,
  pik_pub_hex   TEXT NOT NULL,
  spent_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pb_token_issue (
  server_domain TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_token_issue ON pb_token_issue(server_domain, issued_at);

CREATE TABLE IF NOT EXISTS pb_roots (
  server_domain  TEXT NOT NULL,
  username       TEXT NOT NULL,
  generation     INTEGER NOT NULL,
  revision       INTEGER NOT NULL,
  stored_at      INTEGER NOT NULL,
  nonce_hex      TEXT NOT NULL,
  ciphertext_hex TEXT NOT NULL,
  PRIMARY KEY (server_domain, generation, revision)
);
