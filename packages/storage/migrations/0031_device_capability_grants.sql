-- v2 device-addressing — per-device capability grants on top of the
-- single-IRK-per-user model. Spec: docs/v2-device-addressing-and-real-
-- ticket.md §2 (envelope) and §6 (this schema verbatim).
--
-- The new envelope (`DeviceCapabilityGrant`, packages/protocol/src/auth.ts)
-- is IRK-signed and binds a per-device Ed25519 keypair to a user under a
-- human-meaningful label + a list of authorized scopes. The Worker + the
-- daemon both verify it on every privileged operation; the user IRK
-- continues to authorize "anything" (legacy path), but device IRKs are
-- gated to the scopes their grant declares. The same envelope serves both
-- demo accounts (`demo-alice.reviewer` → browse-only) and corporate
-- deployments (`harry.work-laptop` → install-service + vibe-code).
--
-- Shape mirrors the existing service-grant / auth-code tables — TEXT
-- primary key, hex-encoded crypto material, ms-since-epoch timestamps,
-- a nullable `revoked_at` so the row is RETAINED on revocation so audit
-- + replay paths still resolve. The unique partial index below enforces
-- "at most one ACTIVE grant per (username, device_label)" at the DB
-- level — re-issuance MUST revoke the old row first, otherwise the
-- INSERT will fail with a UNIQUE constraint violation. Parallel to how
-- 0028 piles cascade columns onto usernames; this migration adds its
-- own table because the grants are per-device, not per-user.

CREATE TABLE IF NOT EXISTS device_capability_grants (
  -- SHA-256 hex of canonical bytes; deterministic from envelope content.
  grant_id        TEXT PRIMARY KEY,
  -- The user whose IRK signed the grant. Renames change this column;
  -- existing grants get a fresh row under the new username.
  username        TEXT NOT NULL,
  -- Human-meaningful device label. ASCII, RFC-1035-ish.
  device_label    TEXT NOT NULL,
  -- Device's Ed25519 pubkey, 32 bytes hex.
  device_pub_hex  TEXT NOT NULL,
  -- JSON array of DeviceScope strings (sorted; for stable representation).
  scopes_json     TEXT NOT NULL,
  -- ms since epoch.
  issued_at       INTEGER NOT NULL,
  -- ms since epoch.
  expires_at      INTEGER NOT NULL,
  -- Ed25519 over canonical bytes, 64 bytes hex.
  signature_hex   TEXT NOT NULL,
  -- ms since epoch, NULL = active. Set when a RevokeDeviceCapabilityGrant
  -- lands. The grant row is RETAINED so audit / replay paths still resolve.
  revoked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dcg_username    ON device_capability_grants(username);
CREATE INDEX IF NOT EXISTS idx_dcg_device_pub  ON device_capability_grants(device_pub_hex);
CREATE INDEX IF NOT EXISTS idx_dcg_expires_at  ON device_capability_grants(expires_at);

-- One active grant per (username, device_label). Re-issuance produces
-- a new grant row + a tombstone on the previous via revoked_at.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcg_username_label_active
  ON device_capability_grants(username, device_label)
  WHERE revoked_at IS NULL;
