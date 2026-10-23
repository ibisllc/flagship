-- The boot key binding per server (packages/protocol/src/bootKey.ts). A box
-- keeps a boot-only Ed25519 key on /boot for the jobs before its disk is open
-- (sign boot worker requests, be the recipient of unlock replies and leases);
-- its STK, signing this row's binding, stays inside the encrypted root.
-- .com verifies the signature against the registered STK before storing, and
-- every reader checks stk_pub_hex against the STK the server has now.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS server_boot_keys (
  server_domain     TEXT PRIMARY KEY,
  stk_pub_hex       TEXT NOT NULL,
  boot_key_pub_hex  TEXT NOT NULL,
  issued_at         INTEGER NOT NULL,
  signature_hex     TEXT NOT NULL,
  stored_at         INTEGER NOT NULL
);
