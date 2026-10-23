-- Watch boot keys (docs/watch-boot-approval-without-unlock.md, option (a)). One row per server and
-- watch-delegate key: the server's disk key sealed to that delegate's boot-only decryption key,
-- attested by the account key (flagship/watch-boot-delegate/v1). The boot worker hands it only to the
-- delegate itself, never while the server is suspended (SEC-LOCK-001), and never after expires_at.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS watch_boot_keys (
  server_domain     TEXT NOT NULL,
  delegate_pub_hex  TEXT NOT NULL,
  decrypt_pub_hex   TEXT NOT NULL,
  sealed_key_hex    TEXT NOT NULL,
  key_sha256_hex    TEXT NOT NULL,
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  signature_hex     TEXT NOT NULL,
  deposited_at      INTEGER NOT NULL,
  PRIMARY KEY (server_domain, delegate_pub_hex)
);
CREATE INDEX IF NOT EXISTS idx_wbk_expires_at ON watch_boot_keys(expires_at);
