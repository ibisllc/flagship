-- Durable boot suspension (SEC-LOCK-001). One row per server; absent = never
-- locked. While `suspended` is 1 the boot worker and .com refuse to release any
-- auto-unlock lease for the server, whoever asks. A lock survives possession of
-- the box: the box's own key can set it but never clear it (see
-- packages/protocol/src/bootSuspension.ts for who may change what).
--
-- epoch: owner-controlled; each owner suspend or resume starts epoch + 1.
-- seq:   box-controlled counter inside an epoch; a box can only suspend.
-- signature_hex: the signature of the order that set the current value, so the
-- box and the phones can verify the record themselves.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS boot_suspensions (
  server_domain     TEXT PRIMARY KEY,
  epoch             INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  seq               INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  suspended         INTEGER NOT NULL CHECK (suspended IN (0, 1)),
  reason            TEXT,
  signer            TEXT CHECK (signer IN ('owner', 'box')),
  order_issued_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  signature_hex     TEXT NOT NULL DEFAULT ''
);
