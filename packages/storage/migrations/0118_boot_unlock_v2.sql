-- Boot unlock v2 (packages/protocol/src/bootUnlockV2.ts, docs/architecture-v2/pq-suites.md §19).
--
-- server_boot_key_pq: the boot key's v2 material per server (its ML-DSA half, the X-Wing lease
-- key, the custody label, the boot key's own pq-key-binding and the STK's hybrid signature over
-- flagship/boot-key-binding/v3). .com stores it only when it verifies under the server's stored
-- box-stk binding, and serves it beside the boot-key binding only while both still name the
-- server's current STK and boot key. Phones verify it again under the STK they pinned.
--
-- boot_request_pq: the v2 extension of a parked unlock request (the per-boot reply key and the
-- boot key's hybrid signature), keyed like secret_mailbox. Ciphertext metadata only; it expires
-- with the request. Re-runnable.
CREATE TABLE IF NOT EXISTS server_boot_key_pq (
  server_domain     TEXT PRIMARY KEY,
  stk_pub_hex       TEXT NOT NULL,
  boot_key_pub_hex  TEXT NOT NULL,
  issued_at         INTEGER NOT NULL,
  wire_json         TEXT NOT NULL,
  stored_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boot_request_pq (
  server_domain      TEXT NOT NULL,
  request_nonce_hex  TEXT NOT NULL,
  pq_json            TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  PRIMARY KEY (server_domain, request_nonce_hex)
);
CREATE INDEX IF NOT EXISTS idx_boot_request_pq_expiry ON boot_request_pq(expires_at);
