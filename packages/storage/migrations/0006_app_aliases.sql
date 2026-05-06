-- Per-user app aliases — collapses <slug>.<server>.<user>.flagship.services
-- to <slug>.<user>.flagship.services when unambiguous.
--
-- Conflict semantics: PRIMARY KEY (username, slug) so a second install
-- with the same slug cannot overwrite without an explicit IRK-signed
-- release of the existing alias first.
--
-- See docs/multiplexing.md for full design.

CREATE TABLE IF NOT EXISTS app_aliases (
  username                    TEXT NOT NULL,
  slug                        TEXT NOT NULL,
  -- "<slug>" or "<slug>-<creator>" — the long form's leftmost label,
  -- used to construct the CNAME target. Combined with `server_domain`:
  --   target = `${full_label}.${server_domain}`
  full_label                  TEXT NOT NULL,
  server_domain               TEXT NOT NULL,
  -- v2 replication: JSON array of additional server FQDNs that hold
  -- a live copy + can answer if the primary fails. NULL in v1.
  replication_set             TEXT,
  declared_at                 INTEGER NOT NULL,
  declared_by_irk_pub_hex     TEXT NOT NULL,
  declared_irk_signature_hex  TEXT NOT NULL,
  PRIMARY KEY (username, slug)
);

CREATE INDEX IF NOT EXISTS idx_app_aliases_user ON app_aliases(username);
CREATE INDEX IF NOT EXISTS idx_app_aliases_server ON app_aliases(server_domain);
