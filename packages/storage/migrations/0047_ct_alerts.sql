-- Certificate Transparency monitoring — owner-push dedup ledger.
--
-- The server-side CT watcher (packages/control-plane/src/ctMonitor.ts, run
-- from the 6-hourly cron) queries crt.sh for each active user's
-- `<user>.flagship.services` + `*.<user>.flagship.services` names, compares
-- the observed leaf-cert sha256s against the baseline set reported by the
-- user's own daemons (daemon_status.cert_sha256), and pushes the owner when
-- it sees a cert the user's boxes did NOT mint.
--
-- This table guarantees idempotency: at most ONE owner push per
-- (username, cert_sha256). The scan calls claim_alert_slot before pushing;
-- the unique primary key makes the insert win exactly once.
--
-- NOTE this is the .com-side watcher (defense-in-depth + the data the
-- phone-side CT monitor will reuse). A maliciously-controlled .com could
-- disable its own watcher — the trust-minimized version is phone-side
-- (Phase 2). See the threat-model comment in ctMonitor.ts.

CREATE TABLE IF NOT EXISTS ct_alerts (
  -- Lowercased username.
  username    TEXT NOT NULL,
  -- Normalized leaf-cert sha256: lowercase hex, no colons.
  cert_sha256 TEXT NOT NULL,
  -- ms since epoch — when the owner push first fired.
  alerted_at  INTEGER NOT NULL,
  PRIMARY KEY (username, cert_sha256)
);

CREATE INDEX IF NOT EXISTS idx_ct_alerts_username ON ct_alerts(username);
