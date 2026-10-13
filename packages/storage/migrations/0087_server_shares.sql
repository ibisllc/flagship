-- Share this server (docs/share-a-server.md). .com relays a share between two
-- accounts without learning who the second account is: an opaque share id, a
-- hash of the link's bearer token, and ciphertext only it can't open.

-- One row per share A offers. `offer_hex` / `owner_hex` / `accept_hex` are
-- AES-GCM sealed (link key, A's household key, link key). `end_json` keeps the
-- signed revoke or leave so the box can verify it on its next poll.
CREATE TABLE IF NOT EXISTS server_shares (
  share_id      TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  server_domain TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  offer_hex     TEXT NOT NULL,
  owner_hex     TEXT NOT NULL,
  accept_hex    TEXT,
  accepted_at   INTEGER,
  end_kind      TEXT,
  end_json      TEXT,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_shares_owner ON server_shares (owner_username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_shares_ended ON server_shares (server_domain, ended_at);

-- The second account's copy of the disk key, sealed to its per-share key, put
-- there by A's signed `flagship/server-share-unlock/v1` deposit. Its presence
-- is what lets that key approve the server's start-up at the boot gate.
CREATE TABLE IF NOT EXISTS server_share_unlocks (
  share_id       TEXT PRIMARY KEY,
  server_domain  TEXT NOT NULL,
  member_pub_hex TEXT NOT NULL,
  sealed_key_hex TEXT NOT NULL,
  deposit_json   TEXT NOT NULL,
  signature_hex  TEXT NOT NULL,
  issued_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_share_unlocks_member ON server_share_unlocks (server_domain, member_pub_hex);

-- The second account's "Shared with me" list: entries sealed under a key only
-- its devices derive, addressed by an inbox key unrelated to its account.
CREATE TABLE IF NOT EXISTS share_inbox (
  inbox_id   TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  ct_hex     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (inbox_id, entry_id)
);
