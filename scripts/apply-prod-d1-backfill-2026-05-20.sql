-- Prod-D1 backfill: 10 unapplied migrations (2026-05-20).
--
-- Diagnosis (2026-05-20): a consecutive island of migrations 0006-0019
-- + the App→Service rename ALTERs (0023, 0026) were never executed
-- against prod D1, while newer ones (0021+) WERE. The symptom we hit:
-- /api/users/:u/pods returns Cloudflare 1101 for every user because
-- `daemon_status` (migration 0015) doesn't exist; the SELECT throws
-- "no such table". Eight other features (URL multiplexing, entitlement
-- revocations, user-identity records, recovery passphrase, username
-- aliases, voi.ci, custom-domain pod canonical, app→service rename)
-- have the same shape of breakage.
--
-- Apply with:
--   cd apps/com
--   npx wrangler d1 execute flagship-state --remote \
--     --file=../../scripts/apply-prod-d1-backfill-2026-05-20.sql
--
-- All CREATE TABLE statements are IF NOT EXISTS — safely re-runnable.
-- The four ALTER TABLE statements (0013×2, 0023×1, 0026×1) are
-- one-shot: a second run errors with "duplicate column" or "no such
-- column". That's the loud signal that prod is already current.
--
-- After applying, run:
--   curl -sS -w '%{http_code}\n' \
--     https://flagshipserver.com/api/users/harry11911a/pods
-- and verify HTTP 200.

------------------------------------------------------------------------
-- 0006 — service_aliases (URL multiplexing short-form)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_aliases (
  username                    TEXT NOT NULL,
  slug                        TEXT NOT NULL,
  full_label                  TEXT NOT NULL,
  server_domain               TEXT NOT NULL,
  replication_set             TEXT,
  declared_at                 INTEGER NOT NULL,
  declared_by_irk_pub_hex     TEXT NOT NULL,
  declared_irk_signature_hex  TEXT NOT NULL,
  PRIMARY KEY (username, slug)
);
CREATE INDEX IF NOT EXISTS idx_service_aliases_user   ON service_aliases(username);
CREATE INDEX IF NOT EXISTS idx_service_aliases_server ON service_aliases(server_domain);

------------------------------------------------------------------------
-- 0007 — entitlement_revocation_lists
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlement_revocation_lists (
  username             TEXT PRIMARY KEY,
  cert_ids_json        TEXT NOT NULL,
  irk_signature_hex    TEXT NOT NULL,
  issued_at            INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

------------------------------------------------------------------------
-- 0012 — user_identity_records (encrypted UMK-keyed blob)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identity_records (
  username_hash TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  authorized_signers_json TEXT NOT NULL,
  blob_version INTEGER NOT NULL,
  signature_hex TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

------------------------------------------------------------------------
-- 0013 — recovery passphrase argon2id gates (one-shot ALTERs)
------------------------------------------------------------------------
ALTER TABLE webauthn_recovery_records ADD COLUMN fetch_token_hash TEXT;
ALTER TABLE webauthn_recovery_records ADD COLUMN prf_salt_hash    TEXT;

------------------------------------------------------------------------
-- 0014 — usernames_aliases (permanent username handover)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usernames_aliases (
  old_username  TEXT PRIMARY KEY,
  new_username  TEXT NOT NULL,
  effective_at  INTEGER NOT NULL,
  signature_hex TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usernames_aliases_new ON usernames_aliases(new_username);

------------------------------------------------------------------------
-- 0015 — daemon_status (the /pods 500 cause)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daemon_status (
  server_domain        TEXT PRIMARY KEY,
  cert_sha256          TEXT,
  cert_valid_until     INTEGER,
  cert_issuer          TEXT,
  services_served_json TEXT,
  last_reported        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daemon_status_reported ON daemon_status(last_reported);

------------------------------------------------------------------------
-- 0019 — user_service_aliases + voici_links
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_service_aliases (
  username      TEXT NOT NULL,
  service_id    TEXT NOT NULL,
  display_label TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (username, service_id)
);
CREATE INDEX IF NOT EXISTS idx_user_service_aliases_username ON user_service_aliases(username);

CREATE TABLE IF NOT EXISTS voici_links (
  code        TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  service_id  TEXT,
  target_url  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voici_links_user_service ON voici_links(username, service_id);
CREATE INDEX IF NOT EXISTS idx_voici_links_expires      ON voici_links(expires_at) WHERE expires_at IS NOT NULL;

------------------------------------------------------------------------
-- 0020 — appid double-dash → single-dash rewrite (no-op on fresh tables)
------------------------------------------------------------------------
UPDATE user_service_aliases SET service_id = REPLACE(service_id, '--', '-') WHERE service_id LIKE '%--%';
UPDATE voici_links          SET service_id = REPLACE(service_id, '--', '-') WHERE service_id LIKE '%--%';

------------------------------------------------------------------------
-- 0023 — custom_domain_orders.pod_canonical (one-shot ALTER)
------------------------------------------------------------------------
ALTER TABLE custom_domain_orders ADD COLUMN pod_canonical TEXT;

------------------------------------------------------------------------
-- 0026 — custom_domain_orders.app_id → service_id (one-shot ALTER)
------------------------------------------------------------------------
ALTER TABLE custom_domain_orders RENAME COLUMN app_id TO service_id;
