-- Mint reservation lease — the dead-lead-safe CAS lock that serializes who
-- re-mints a user's per-user TLS cert this cycle (per-user-cert design).
--
-- A minter (admin device or "autonomous" box) acquires the lease before
-- minting; others back off while it's live; if the holder dies the TTL
-- lapses (δ ≈ one ACME order, ≪ remaining cert life) and the next minter
-- takes over. One row per user (username PRIMARY KEY) makes the SQLite
-- conditional upsert (INSERT … ON CONFLICT(username) DO UPDATE … WHERE
-- expired OR same-holder) an atomic compare-and-set under D1's single writer.
-- The lease is non-secret coordination metadata — best-effort; a daemon that
-- can't reach .com falls back to a deterministic local order.

CREATE TABLE IF NOT EXISTS mint_reservations (
  username        TEXT PRIMARY KEY,
  -- The minter currently holding the lease (signing pubkey, hex).
  holder_pub_hex  TEXT NOT NULL,
  -- ms since epoch.
  acquired_at     INTEGER NOT NULL,
  -- ms since epoch; the lease is reclaimable once now >= expires_at.
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mint_res_expires ON mint_reservations(expires_at);
