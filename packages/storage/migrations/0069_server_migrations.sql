-- server_migrations — the server-migration orchestration lane
-- (docs/server-migration.md; the "migrations lane" of the 8-phase state
-- machine). One row per migrating pod FQDN — v1 runs at most one migration
-- per name at a time; re-initiating replaces only a terminal (aborted /
-- taken-over) session.
--
-- The row carries the ADMIN-SIGNED ServerMigrationOrder verbatim (order_json
-- + order_signature_hex) so both boxes re-verify it under their pinned
-- authority — `.com` is never a trust anchor. The handshake columns mirror
-- server_evictions' style: each phase transition stamps its column, and the
-- `phase` TEXT column is the authoritative cursor
-- (initiated → provisioned → pre-seeded → ready → freezing → taken-over,
-- with aborted as the terminal escape before the point of no return).
-- The final-delta barrier is NOT duplicated here — it is read live from the
-- eviction row's epoch_complete_at (the freeze phase reuses the decommission
-- lane wholesale). All hex + hostname columns are lowercase.

CREATE TABLE IF NOT EXISTS server_migrations (
  server_domain        TEXT PRIMARY KEY,
  username             TEXT NOT NULL,
  old_stk_pub_hex      TEXT NOT NULL,
  order_json           TEXT NOT NULL,
  order_signature_hex  TEXT NOT NULL,
  disposition          TEXT NOT NULL,
  phase                TEXT NOT NULL,
  initiated_at         INTEGER NOT NULL,
  new_server_domain    TEXT,
  new_stk_pub_hex      TEXT,
  attached_at          INTEGER,
  pre_seeded_at        INTEGER,
  ready_at             INTEGER,
  freeze_at            INTEGER,
  taken_over_at        INTEGER,
  aborted_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_server_migrations_user ON server_migrations(username);
