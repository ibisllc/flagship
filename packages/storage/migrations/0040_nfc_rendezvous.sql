-- NFC rendezvous (C3 — cloud side of the NFC tap-to-pair flow).
--
-- One-shot drop-box used when the phone and box can't reach each other
-- over LAN. The phone POSTs a sealed WiFi-config blob keyed by
-- PairPayload.hint.cloudRendezvousId; the box polls the same key. The
-- blob is AES-GCM AEAD-sealed under K_session (the ECDH the phone +
-- box independently derived from the NFC tap), so this table is just
-- opaque ciphertext — the cloud holds no secret material.
--
-- Lifecycle:
--   - phone POST → INSERT-or-REPLACE (re-tap after a typo'd WiFi
--     password just overwrites the slot)
--   - box GET   → SELECT + DELETE atomically; one-shot, so a stale
--     deposit never lingers
--   - expired rows are dropped by a periodic purge (defensive — the
--     box's poll loop normally consumes well before the 15-min TTL)
--
-- See docs/v1-operational-tasks.md § N-CLOUD-3 and
--     packages/control-plane/src/nfcRendezvous.ts

CREATE TABLE IF NOT EXISTS nfc_rendezvous (
  rendezvous_id   TEXT PRIMARY KEY,
  sealed_hex      TEXT NOT NULL,
  nonce_hex       TEXT NOT NULL,
  deposited_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nfc_rendezvous_expires
  ON nfc_rendezvous(expires_at);
