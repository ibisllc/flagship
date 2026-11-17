-- Blind-signed $1 vouchers (docs/payments-privacy-and-rails.md "As built"; RFC 9474).
--
-- voucher_nullifiers: one row per spent voucher. Holds the nullifier (SHA-256 of the key id and the voucher's nonce),
-- the key it was signed under and the UTC day it was spent. Never the account it paid for, never an address, never a
-- time finer than the day: a spend must not be joinable to the purchase or to the account by this table.
-- Single use: the primary key makes a second spend fail (INSERT OR IGNORE, changes = 0).
--
-- voucher_wallets: the account's wallet, sealed on the phones under a key from the account's UMK
-- (flagship/voucher-wallet/v1), synced between the account's devices like the call hours (0150). `.com` stores the
-- ciphertext only and never learns the balance (the plaintext is padded to 4 KiB × 2^i). Compare-and-set on version.
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS voucher_nullifiers (
  nullifier  TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL,
  spent_day  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voucher_wallets (
  username   TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
