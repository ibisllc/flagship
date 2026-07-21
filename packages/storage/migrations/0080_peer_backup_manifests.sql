-- peer_backup_manifests — the SWK-sealed shard-placement manifest lane
-- (server-migration Layer 0; docs/server-migration.md invariant 4).
--
-- One row per server. The owning box deposits its manifest (sealed under
-- a key derived from the deterministic SWK) after every backup run; a
-- fresh replacement box for the same serverId re-derives the SWK, fetches
-- the row, and opens it to learn which peer holds which shard. `.com`
-- only ever sees ciphertext. Latest-wins by the box-signed `generation`
-- (the handler rejects generation <= stored, so a replayed older deposit
-- can never roll the recovery root back). Reads are non-consuming — the
-- manifest is a recovery root, and a crashed restore must be able to
-- fetch it again. All hex columns are lowercase.

CREATE TABLE IF NOT EXISTS peer_backup_manifests (
  server_domain  TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  generation     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  ciphertext_hex TEXT NOT NULL,
  nonce_hex      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_peer_backup_manifests_user ON peer_backup_manifests(username);
