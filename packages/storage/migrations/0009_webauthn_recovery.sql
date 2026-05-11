-- WebAuthn-PRF cloud-shard recovery records.
--
-- The webapp wraps its UMK seed under a passkey's PRF output and
-- uploads the ciphertext here. `.com` only ever holds opaque
-- ciphertext + the credentialId pointer; the unwrap key never
-- leaves the user's browser.
--
-- Keyed by username (matches the existing usernames table) so a
-- recovering browser can fetch by the user-memorable identifier.
-- Upload is IRK-signed; .com cross-checks the IRK pubkey here
-- against the existing usernames row before upserting.
CREATE TABLE IF NOT EXISTS webauthn_recovery_records (
  username TEXT PRIMARY KEY,
  credential_id_hex TEXT NOT NULL,
  wrapped_umk_b64 TEXT NOT NULL,
  irk_pub_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
