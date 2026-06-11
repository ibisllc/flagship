-- boot_nonces — the boot gate's single-use replay-defense nonce store.
--
-- When the BOOT operations (`/api/boot/*`) ran on the dedicated
-- flagship-boot worker, this table lived in that worker's own D1
-- (apps/boot/migrations/0001). The boot operations now run on the identity
-- plane itself (boot.flagshipserver.com collapsed onto flagship-com — see
-- docs/boot-worker-consolidation.md), so the nonce store must exist in
-- `flagship-state` alongside `secret_mailbox` (0037) + `box_sealed_leases`
-- (0037), which it already has.
--
-- The PRIMARY KEY on nonce_key makes the single-use claim atomic: a
-- duplicate INSERT fails. Keyed by (role|server_domain|nonce); expired rows
-- are deleted on claim so a key can be reused after its freshness window
-- passes. ADDITIVE + IDEMPOTENT.

CREATE TABLE IF NOT EXISTS boot_nonces (
  nonce_key   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (nonce_key)
);

CREATE INDEX IF NOT EXISTS idx_boot_nonces_expiry
  ON boot_nonces(expires_at);
