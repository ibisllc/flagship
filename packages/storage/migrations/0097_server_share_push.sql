-- Share this server (docs/share-a-server.md §5.4): a co-manager's devices that
-- asked to be woken when the shared server waits to start. Keyed by the share,
-- never by the co-manager's account. A row is accepted only while the owner's
-- unlock deposit for the same per-share key stands, and goes with that deposit
-- (withdrawn, revoked or left).
CREATE TABLE IF NOT EXISTS server_share_push (
  share_id       TEXT NOT NULL,
  server_domain  TEXT NOT NULL,
  member_pub_hex TEXT NOT NULL,
  token_sha256   TEXT NOT NULL,
  platform       TEXT NOT NULL,
  provider_token TEXT NOT NULL,
  registered_at  INTEGER NOT NULL,
  PRIMARY KEY (share_id, token_sha256)
);
CREATE INDEX IF NOT EXISTS idx_server_share_push_server ON server_share_push (server_domain);
