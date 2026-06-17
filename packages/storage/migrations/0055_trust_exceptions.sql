-- trust_exceptions — owner-signed, per-cert maintainer-trust overrides,
-- synced through `.com` (docs/maintainer-trust-enforcement.md "Recovery").
--
-- A TrustException un-sticks a box from a broken-trust state (control- or
-- relay-blessing expired/invalid). It is device-key-signed + cert-hash-
-- scoped, so routing it through a possibly-rogue `.com` is safe: `.com` can
-- drop or replay it but cannot forge it. The PRIMARY KEY (username,
-- cert_hash) gives "one acceptance per cert, fleet-wide" — a re-sync of the
-- same cert replaces the row (last-writer; replay is benign). The consuming
-- box re-verifies the envelope against its IRK-anchored device set before
-- honoring it, so this table is a directory, not an authority.
--
-- ADDITIVE + IDEMPOTENT.

CREATE TABLE IF NOT EXISTS trust_exceptions (
  username               TEXT NOT NULL,
  cert_hash              TEXT NOT NULL,
  cert_class             TEXT NOT NULL,
  granted_at             INTEGER NOT NULL,
  granted_by_device_pub  TEXT NOT NULL,
  envelope_json          TEXT NOT NULL,
  stored_at              INTEGER NOT NULL,
  PRIMARY KEY (username, cert_hash)
);

CREATE INDEX IF NOT EXISTS idx_trust_exceptions_user
  ON trust_exceptions(username, granted_at DESC);
