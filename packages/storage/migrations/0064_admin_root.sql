-- Slice D — device admin / authority tier (docs/device-admin-tier-spec.md).
--
-- Two roots per account (§1): the MEMBERSHIP IRK (`irk_pub_hex`, UMK-derived,
-- held by every device, unchanged) stays the membership root; a SEPARATE
-- ADMIN MASTER ROOT — a fresh random Ed25519 keypair minted at account
-- creation, NOT UMK-derived, held only by admin devices — becomes the
-- AUTHORITY root. Only administrative/destructive ops verify against it.
--
-- This migration adds the two clean-slate columns the D spine needs:
--
--   1. usernames.admin_root_pub_hex — the account's pinned admin master-root
--      pubkey (hex). NULLABLE for the ALTER (pre-migration rows decode as
--      NULL); the claim handler records it when the client supplies one. A
--      row with NULL here has no admin authority anchor yet — `.com`/box code
--      treats absence as "no admin root" (deny sensitive ops). Set next to
--      `irk_pub_hex` at handleUsernameClaim.
--
--   2. device_capability_grants.signer_root — the grant-signer discriminator
--      (§3.3). `'membership'` (the DEFAULT, backward-compatible with every
--      existing IRK-signed grant) vs `'admin-root'`. An `admin`-scope grant
--      is only load-bearing when it is `'admin-root'`-signed; the shared
--      `requireMasterAdmin` predicate rejects a `'membership'`-signed grant
--      for a sensitive scope so a UMK holder (or a compromised `.com`) cannot
--      forge admin authority.
--
-- Additive + nullable/defaulted, so applying it to a populated DB is safe and
-- pre-migration reads keep working. Clean-slate: fresh burns pin BOTH roots
-- from day one (docs/device-admin-tier-spec.md §7).

ALTER TABLE usernames ADD COLUMN admin_root_pub_hex TEXT;

ALTER TABLE device_capability_grants ADD COLUMN signer_root TEXT NOT NULL DEFAULT 'membership';
