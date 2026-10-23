-- The recovery passkey's public key (SEC-REPAIR-001, owner decision 2026-10-24).
--
--   passkey_cose_hex  the passkey's COSE_Key (hex), read from the attestation object at enrolment.
--   passkey_alg       its COSE algorithm (-7 ES256, -8 EdDSA, -257 RS256).
--
-- A row with a key: `.com` requires a passkey assertion over its own challenge before it releases
-- the wrapped key or mints a recovery proof. NULL on rows enrolled before; they keep the
-- passphrase-only gate until the owner updates their recovery.
--
-- Apply-once (bare ADD COLUMN): see README.md.
ALTER TABLE webauthn_recovery_records ADD COLUMN passkey_cose_hex TEXT;
ALTER TABLE webauthn_recovery_records ADD COLUMN passkey_alg INTEGER;

-- One use per challenge: the nonce of each challenge a valid assertion answered, kept until it would
-- have expired anyway.
CREATE TABLE IF NOT EXISTS recovery_challenges_used (
  nonce_hex  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- What Studio read on the console of a VM it hosts (first contact, docs/first-contact.md): the server's
-- key and Studio's MAC over it under a key only the phone and Studio hold. JSON list, a few at most.
ALTER TABLE provision_status ADD COLUMN server_seen TEXT;
