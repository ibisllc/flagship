-- Slice D (D-3, docs/device-admin-tier-spec.md §5.3): escrow the ADMIN MASTER
-- ROOT in the WebAuthn-PRF recovery envelope, wrapped to the same recovery
-- credential as the UMK (distinct HKDF salt,
-- "flagship/recovery-admin-root-wrap/v1").
--
-- The admin root is admin-held (NOT UMK-derived), so losing every admin device
-- would otherwise make admin authority unrecoverable. Storing the wrapped
-- (ciphertext-only) root here lets credential recovery unwrap the OLD root,
-- mint a new one, and sign the `admin-root-rotation/v1` proof (migration 0066)
-- that boxes re-pin on — `.com` never sees plaintext and can never forge
-- authority. Nullable: legacy rows and accounts without an admin root leave it
-- unset.
--
-- APPLY-ONCE (see migrations/README.md, finding OPS-B): SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so re-running this file aborts with
-- `duplicate column name: wrapped_admin_root_b64`. That error means the
-- migration is ALREADY applied — it is safe; do NOT "fix" it by dropping the
-- column.

ALTER TABLE webauthn_recovery_records
  ADD COLUMN wrapped_admin_root_b64 TEXT;
