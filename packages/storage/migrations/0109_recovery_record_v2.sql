-- Signed, versioned cloud-recovery record (SECURITY-HARDENING-PLAN.md 18.3, N03).
--
--   record_digest_hex  SHA-256 of the signed v2 claim: the chain link the next write must name.
--                      NULL on a v1 row, which the first v2 write replaces (prior "legacy").
--   generation         1 for the first v2 record, then +1 per accepted write.
--   signed_claim_json  the claim exactly as signed, served beside the ciphertext so a client can
--                      check each ciphertext against its signed digest before unwrapping.
--   signature_hex      the account key's signature over that claim.
--
-- Apply-once (bare ADD COLUMN): see README.md.
ALTER TABLE webauthn_recovery_records ADD COLUMN record_digest_hex TEXT;
ALTER TABLE webauthn_recovery_records ADD COLUMN generation INTEGER;
ALTER TABLE webauthn_recovery_records ADD COLUMN signed_claim_json TEXT;
ALTER TABLE webauthn_recovery_records ADD COLUMN signature_hex TEXT;
