-- Account members, ranks and who may change them (owner decision 2026-10-15,
-- docs/service-access-gating.md): a box prunes the people an invite let in
-- only for a revoke it verifies itself (an admin's, or the creating device's
-- while that device may still invite there). `.com` keeps the signed revoke
-- beside the revocation and serves it on `revoked-since`.
--
--   revoke_sig             the revoke envelope's signature (hex)
--   revoke_issued_at       the envelope's signed issuedAt (ms)
--   revoke_signer_pub_hex  the key it verified under on `.com` (a hint)
--
-- NULL on rows revoked before this file. Apply-once (bare ADD COLUMN): see README.md.
ALTER TABLE service_invites ADD COLUMN revoke_sig TEXT;
ALTER TABLE service_invites ADD COLUMN revoke_issued_at INTEGER;
ALTER TABLE service_invites ADD COLUMN revoke_signer_pub_hex TEXT;
