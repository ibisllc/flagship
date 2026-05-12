-- Encrypted user-identity mandate store (#71).
--
-- Per-user state lives inside an opaque AES-GCM blob — labels, device
-- names, friend names, app entries, anything the user attaches a string
-- to. `.com` cannot decrypt the blob; only the user's UMK-derived key
-- can. See docs/policy/no-kyc.md.
--
-- The plaintext columns here are the *minimum* the Worker needs to
-- gate writes:
--   - username_hash   identifies the row (SHA-256 of a salted username;
--                     see packages/control-plane/src/userIdentity.ts
--                     for the salt scheme).
--   - authorized_signers_json  the user's own published list of pubkeys
--                     allowed to update this row. The PUT endpoint
--                     verifies the supplied Ed25519 signature against
--                     ONE of these pubkeys.
--   - blob_version    monotonic; an older version is rejected so a
--                     captured stale write can't be replayed to roll the
--                     blob back.
--   - signature_hex   Ed25519 signature over the canonical bytes
--                     (encrypted_blob | blob_version), retained so any
--                     replica can re-verify after fetch.
--
-- Everything inside encrypted_blob stays opaque. No friend graph, no
-- device names, no app names leak to `.com` even with a full D1 dump.
CREATE TABLE IF NOT EXISTS user_identity_records (
  username_hash TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  authorized_signers_json TEXT NOT NULL,
  blob_version INTEGER NOT NULL,
  signature_hex TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
