-- Prepaid Pro vouchers (#9).
--
-- A voucher is a BEARER secret sold for cash/Monero with no identity attached.
-- Redeeming it grants its tier for `duration_days` to a username of the
-- redeemer's choice (the code is the payment proof; whoever holds it uses it).
--
-- We store only the SHA-256 of the (normalized) code, so a DB leak never
-- reveals an unredeemed code. Single-use: `redeemed_at` is set ATOMICALLY on
-- the first redemption (`UPDATE ... WHERE redeemed_at IS NULL`), so a race
-- can't double-grant.

CREATE TABLE IF NOT EXISTS vouchers (
  -- sha-256 hex of the normalized voucher code (uppercase, alphanumerics only).
  code_hash     TEXT PRIMARY KEY,
  -- granted tier ("hobby" = Pro/250GB, "maker" = 1TB).
  tier          TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- NULL until redeemed.
  redeemed_at   INTEGER,
  -- username the voucher was applied to (NULL until redeemed).
  redeemed_by   TEXT
);
