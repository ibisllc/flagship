-- AcmeAccountKeyGrant — the sealed ACME account key handed to each admin
-- device (per-user-cert design). Spec: docs/per-user-cert-and-addressing.md §4.
-- Envelope: AcmeAccountKeyGrant in packages/protocol/src/auth.ts (IRK-signed).
--
-- A device holding the `admin` DeviceScope may mint/renew the user's per-user
-- TLS cert; to do so it needs the ACME ACCOUNT key. The account root seals the
-- account key to each admin device's pubkey and distributes it via this grant.
-- `.com` only ever stores the OPAQUE ciphertext (sealed_account_key_hex) — it
-- can carry the grant but never read the key.
--
-- Shape parallels watch_delegates (0041) — TEXT primary key (the envelope's v4
-- UUID grantId, itself part of the signed canonical bytes), hex crypto
-- material, ms-since-epoch timestamps, a nullable revoked_at so the row is
-- RETAINED on revoke for audit. TWO deliberate differences from watch
-- delegates:
--   • MULTIPLE active grants per user are ALLOWED — each admin device holds its
--     own sealed copy — so there is deliberately NO unique-active index.
--   • account_key_id (sha256-hex of the ACME account PUBLIC key) is indexed so
--     rotation can tombstone EVERY grant of a retired key in one statement
--     (RevokeAcmeAccountKey on admin demotion / compromise).

CREATE TABLE IF NOT EXISTS acme_account_key_grants (
  -- v4-UUID grantId from the signed AcmeAccountKeyGrant envelope.
  grant_id                TEXT PRIMARY KEY,
  -- The account whose IRK signed the grant.
  username                TEXT NOT NULL,
  -- sha256-hex of the ACME account PUBLIC key; shared by every grant of the
  -- same key, changes on rotation. The handle revokeByAccountKeyId keys on.
  account_key_id          TEXT NOT NULL,
  -- The recipient admin device's Ed25519 pubkey, 32 bytes hex.
  recipient_pub_hex       TEXT NOT NULL,
  -- The ACME account key sealed to recipient_pub_hex — opaque ciphertext hex.
  sealed_account_key_hex  TEXT NOT NULL,
  -- ms since epoch.
  issued_at               INTEGER NOT NULL,
  -- ms since epoch; re-seal before expiry.
  expires_at              INTEGER NOT NULL,
  -- Ed25519 IRK signature over the canonical bytes, 64 bytes hex.
  signature_hex           TEXT NOT NULL,
  -- ms since epoch, NULL = active. Set on RevokeAcmeAccountKey / demotion.
  revoked_at              INTEGER
);

CREATE INDEX IF NOT EXISTS idx_aakg_username       ON acme_account_key_grants(username);
CREATE INDEX IF NOT EXISTS idx_aakg_recipient_pub  ON acme_account_key_grants(recipient_pub_hex);
CREATE INDEX IF NOT EXISTS idx_aakg_account_key_id ON acme_account_key_grants(account_key_id);

-- NO unique-active index: multiple admin devices each hold an active grant of
-- the same account key for the same user. Uniqueness is only on grant_id (PK).
