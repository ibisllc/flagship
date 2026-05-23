-- Phone-as-unlock-endpoint RELAY model — the blind store-and-forward
-- mailbox + the box-sealed auto-unlock lease. Spec:
-- docs/security-phone-as-unlock-endpoint.md §4 (handshake), §7a
-- (box-sealed lease + rogue-operator invariants I1/I2/I3), §9 (deltas).
--
-- ADDITIVE + IDEMPOTENT. The legacy plaintext unlock path
-- (unlock_key_deposits, auto_unlock_leases) is UNTOUCHED and stays as a
-- deprecated fallback this wave — these tables sit alongside it.
--
-- Rogue-operator invariants encoded structurally:
--   I1 (no plaintext at .com): secret_mailbox carries only the SEALED
--       response (response_sealed_hex); box_sealed_leases carries only
--       the SEALED key (sealed_key_hex). Neither table has a plaintext
--       key column.
--   I2 (user-anchored pinned recipient): box_sealed_leases.stk_pub_hex
--       is the seal recipient + is covered by the IRK signature stored
--       in signature_hex — .com cannot retarget the seal.
--   I3 (.com is gate/router/push only): nothing here lets .com read or
--       forge; it only stores ciphertext + public-signed blobs and
--       gates the single-use release.

-- ── Secret mailbox ────────────────────────────────────────────────────
-- One row per (server_domain, request_nonce_hex). The composite PRIMARY
-- KEY enforces the single-use nonce: a re-posted nonce fails the INSERT.
-- The box posts a request; .com pushes the phone; the phone writes the
-- sealed reply (write-once); the box consumes it once (consumed_at).
CREATE TABLE IF NOT EXISTS secret_mailbox (
  -- Box FQDN the request is for.
  server_domain         TEXT NOT NULL,
  -- Account that owns the mailbox (the box's registered username).
  username              TEXT NOT NULL,
  -- 32-byte request nonce, hex — the per-request key.
  request_nonce_hex     TEXT NOT NULL,
  -- Box STK pubkey, hex. The request was verified against this AND
  -- against the directory-bound STK for server_domain at the handler.
  stk_pub_hex           TEXT NOT NULL,
  -- 'unlock-key' | 'entitlement'.
  purpose               TEXT NOT NULL,
  -- issuedAt from the signed SecretRequest (ms).
  request_issued_at     INTEGER NOT NULL,
  -- Box STK signature over the canonical SecretRequest, hex. Stored so
  -- the phone can re-verify the request against the directory STK it
  -- independently looks up — .com is not the trust anchor.
  request_signature_hex TEXT NOT NULL,
  -- Box-supplied display hint (ip/region/os) JSON for the "is this my
  -- box?" confirm. NOT signed, NOT the security boundary. NULL if absent.
  device_info_json      TEXT,
  -- When the box posted the request (ms).
  posted_at             INTEGER NOT NULL,
  -- Row TTL — .com refuses to serve / GCs past this (ms).
  expires_at            INTEGER NOT NULL,
  -- Wall-clock ms of the last push fan-out, or 0.
  last_push_at          INTEGER NOT NULL DEFAULT 0,
  -- The phone's reply, SEALED for stk_pub_hex (or the signed entitlement
  -- carrier), hex. NULL until the phone replies. NEVER plaintext (I1).
  response_sealed_hex   TEXT,
  -- issuedAt from the phone's SealedSecretResponse (ms), or NULL.
  response_issued_at    INTEGER,
  -- When the phone posted the reply (ms), or NULL.
  responded_at          INTEGER,
  -- Set when the box consumes the reply — single-use release.
  consumed_at           INTEGER,
  PRIMARY KEY (server_domain, request_nonce_hex)
);

-- Phone mailbox listing: pending requests for the user, newest first.
CREATE INDEX IF NOT EXISTS idx_secret_mailbox_user
  ON secret_mailbox(username, posted_at);
-- TTL sweep.
CREATE INDEX IF NOT EXISTS idx_secret_mailbox_expiry
  ON secret_mailbox(expires_at);

-- ── Box-sealed auto-unlock leases (AutoUnlockLeaseV2) ─────────────────
-- (server_domain, lease_id) PK — multiple leases (e.g. phone AND webapp)
-- can coexist per server, each independently revocable. Distinct from
-- auto_unlock_leases (legacy PLAINTEXT path). Here the key is SEALED for
-- the PINNED stk_pub_hex; .com never sees plaintext (I1) and cannot
-- retarget the seal (I2).
CREATE TABLE IF NOT EXISTS box_sealed_leases (
  server_domain  TEXT NOT NULL,
  lease_id       TEXT NOT NULL,
  -- PINNED seal recipient — box STK pubkey, hex (covered by signature).
  stk_pub_hex    TEXT NOT NULL,
  -- The LUKS key sealed for stk_pub_hex, hex. NEVER plaintext (I1).
  sealed_key_hex TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  -- Release cap; NULL ⇒ unbounded until expires_at.
  max_uses       INTEGER,
  -- Releases so far; incremented on each box reboot consume.
  uses_consumed  INTEGER NOT NULL DEFAULT 0,
  -- IRK signature over the canonical AutoUnlockLeaseV2, hex. Released to
  -- the box so it re-verifies the lease under the user IRK independently
  -- of .com.
  signature_hex  TEXT NOT NULL,
  deposited_at   INTEGER NOT NULL,
  PRIMARY KEY (server_domain, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_box_sealed_leases_server
  ON box_sealed_leases(server_domain);
CREATE INDEX IF NOT EXISTS idx_box_sealed_leases_expiry
  ON box_sealed_leases(expires_at);
