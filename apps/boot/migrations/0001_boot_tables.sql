-- boot.flagshipserver.com — the dedicated boot worker's own D1 schema.
--
-- Holds ONLY ciphertext + public-signed artifacts (invariant I1: the
-- boot worker never sees plaintext keys) plus a single-use nonce store
-- for replay defense.
--
-- The secret_mailbox + box_sealed_leases tables mirror the identity
-- plane's relay schema (packages/storage/migrations/0037), so the same
-- @flagship/storage D1 adapters work unchanged against this DB. The
-- boot_nonces table is new and specific to this worker's identity gate.
--
-- ADDITIVE + IDEMPOTENT.

-- ── Secret mailbox ────────────────────────────────────────────────────
-- One row per (server_domain, request_nonce_hex). The composite PRIMARY
-- KEY enforces the single-use nonce. The box posts a request; the boot
-- worker fires the notify pipe (→ identity plane → push); the phone
-- writes the sealed reply (write-once); the box consumes it once.
CREATE TABLE IF NOT EXISTS secret_mailbox (
  server_domain         TEXT NOT NULL,
  username              TEXT NOT NULL,
  request_nonce_hex     TEXT NOT NULL,
  stk_pub_hex           TEXT NOT NULL,
  purpose               TEXT NOT NULL,
  request_issued_at     INTEGER NOT NULL,
  request_signature_hex TEXT NOT NULL,
  device_info_json      TEXT,
  posted_at             INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  last_push_at          INTEGER NOT NULL DEFAULT 0,
  -- The phone's reply, SEALED for stk_pub_hex. NEVER plaintext (I1).
  response_sealed_hex   TEXT,
  response_issued_at    INTEGER,
  responded_at          INTEGER,
  consumed_at           INTEGER,
  PRIMARY KEY (server_domain, request_nonce_hex)
);

CREATE INDEX IF NOT EXISTS idx_secret_mailbox_user
  ON secret_mailbox(username, posted_at);
CREATE INDEX IF NOT EXISTS idx_secret_mailbox_expiry
  ON secret_mailbox(expires_at);

-- ── Box-sealed auto-unlock leases (AutoUnlockLeaseV2) ─────────────────
-- (server_domain, lease_id) PK. The LUKS key is SEALED for the PINNED
-- stk_pub_hex; the boot worker never sees plaintext (I1) and cannot
-- retarget the seal (I2 — stk_pub_hex is covered by the IRK signature
-- stored in signature_hex).
CREATE TABLE IF NOT EXISTS box_sealed_leases (
  server_domain  TEXT NOT NULL,
  lease_id       TEXT NOT NULL,
  stk_pub_hex    TEXT NOT NULL,
  sealed_key_hex TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  max_uses       INTEGER,
  uses_consumed  INTEGER NOT NULL DEFAULT 0,
  signature_hex  TEXT NOT NULL,
  deposited_at   INTEGER NOT NULL,
  PRIMARY KEY (server_domain, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_box_sealed_leases_server
  ON box_sealed_leases(server_domain);
CREATE INDEX IF NOT EXISTS idx_box_sealed_leases_expiry
  ON box_sealed_leases(expires_at);

-- ── Single-use nonce store (the identity gate's replay defense) ────────
-- The PRIMARY KEY on nonce_key makes the single-use claim atomic: a
-- duplicate INSERT fails. Keyed by (role|server_domain|nonce); expired
-- rows are deleted on claim so a key can be reused after its freshness
-- window passes.
CREATE TABLE IF NOT EXISTS boot_nonces (
  nonce_key   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (nonce_key)
);

CREATE INDEX IF NOT EXISTS idx_boot_nonces_expiry
  ON boot_nonces(expires_at);
