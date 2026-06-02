-- Per-user-cert (#28): escrow the ACME ACCOUNT key in the WebAuthn-PRF
-- recovery envelope, wrapped to the same recovery credential as the UMK.
--
-- The account key is admin-held (NOT UMK-derived), so losing every admin
-- device would otherwise brick cert issuance forever. Storing the wrapped
-- (ciphertext-only) account key here makes it recoverable independently of
-- any surviving device — .com never sees plaintext. Nullable: legacy rows
-- and accounts without a minted account key leave it unset.

ALTER TABLE webauthn_recovery_records
  ADD COLUMN wrapped_acme_account_key_b64 TEXT;
