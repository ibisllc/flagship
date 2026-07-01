-- Slice D — Phase 1: persist the AuthCode's admin master root (spine deviation #5).
--
-- The account's ADMIN MASTER ROOT rides INSIDE the signed `AuthCode`
-- (`AuthCode.adminRootPubKey`, signature-covered + registration-gated, like
-- `ownerAidPubHex` — docs/device-admin-tier-spec.md §D-1). The Phase-0 spine
-- added the canonical-bytes field + the daemon read, but `.com` neither
-- PERSISTED it on the auth-code record nor RECONSTRUCTED it when
-- `handleServerRegister` re-verifies the AuthCode signature — so a client-signed
-- AuthCode carrying `adminRootPubKey` would fail re-verification (the bytes the
-- phone signed included `ar=<hex>`, but `.com` rebuilt them without it). This
-- column closes that gap: the admin anchor is stored at auth-code ISSUE time and
-- threaded back through validate-and-use, so registration re-verification and
-- box delivery see the exact bytes the phone signed.
--
-- Nullable + additive: pre-0065 rows and any AuthCode minted WITHOUT an admin
-- root decode as NULL (the canonical bytes are byte-identical when it is absent,
-- so old signatures keep verifying). Clean-slate burns will carry it from day one.

ALTER TABLE auth_codes ADD COLUMN admin_root_pub_key_hex TEXT;
