-- Slice D §9.8 — transfer-a-box admin-root handoff
-- (docs/device-admin-tier-spec.md §9.8; docs/account-deletion-and-name-reclaim.md §4).
--
-- On a transfer the box must re-pin the ACQUIRER's admin master root — and it
-- must never take `.com`'s word for it. Two additions to the claimed transfer
-- row:
--   1. `acquirer_admin_root_pub_hex` — the acquirer's admin root the CLAIM
--      itself commits to (claim canonical v2, signature-covered), "" when the
--      acquirer account has no admin root. Recorded at claim so the giver's
--      phone can read it back and fold it into the handoff proof.
--   2. The `admin_handoff_*` columns — the GIVER-admin-root-signed
--      `flagship/admin-root-transfer/v1` proof (old giver root → new acquirer
--      root, bound to this box + this offer's nonce). `.com` verifies it
--      against the giver account's registered `admin_root_pub_hex` as a
--      garbage filter and RELAYS it; the box re-verifies against its PINNED
--      anchor and re-pins only on a valid proof — `.com` cannot forge one.
-- Mirrors the 0060 disk-key handoff shape (deposited post-claim, idempotent
-- re-deposit replaces). All hex/username columns stored lowercase.

ALTER TABLE server_transfers ADD COLUMN acquirer_admin_root_pub_hex TEXT;
ALTER TABLE server_transfers ADD COLUMN admin_handoff_old_root_hex TEXT;
ALTER TABLE server_transfers ADD COLUMN admin_handoff_new_root_hex TEXT;
ALTER TABLE server_transfers ADD COLUMN admin_handoff_issued_at INTEGER;
ALTER TABLE server_transfers ADD COLUMN admin_handoff_sig_hex TEXT;
