-- Task #74 — Argon2id-gated wrappedUmk fetch.
--
-- Before this migration the `/api/recovery/by-username/<u>` endpoint
-- returned the wrapped-UMK ciphertext to anyone who knew the username.
-- Combined with rate-limiting + the WebAuthn-PRF unwrap requirement
-- that was already a meaningful gate, but it meant an attacker with
-- the wrapped blob could mount offline attacks against PRF-equivalent
-- credentials (or wait until a stolen YubiKey ceremony).
--
-- This migration adds two passphrase-derived hashes to the existing
-- webauthn_recovery_records row:
--
--   fetch_token_hash : SHA-256(HKDF(Argon2id(passphrase, ...),
--                                  "flagship.recovery.fetch.v1"))
--                      Required on every fetch — .com only releases
--                      the ciphertext when the caller proves
--                      possession of the passphrase by presenting the
--                      pre-image bytes.
--
--   prf_salt_hash    : SHA-256(HKDF(Argon2id(passphrase, ...),
--                                  "flagship.recovery.salt.v1"))
--                      Bound to the PRF salt the webapp uses for
--                      WebAuthn `prf.eval.first`. Stored only as a
--                      hash so .com cannot itself derive the PRF
--                      output even if it later colluded with the
--                      authenticator vendor.
--
-- Both are nullable so existing rows (uploaded before this migration)
-- continue to fetch under the legacy unrated path until users re-enrol.
-- The legacy GET endpoint is being retired in the same release as this
-- migration — see packages/control-plane/src/webauthnRecovery.ts.
ALTER TABLE webauthn_recovery_records
  ADD COLUMN fetch_token_hash TEXT;
ALTER TABLE webauthn_recovery_records
  ADD COLUMN prf_salt_hash TEXT;
