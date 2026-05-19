-- Task #21 — Daemon-reported pod status (cert + services).
--
-- Each user's daemon POSTs to /api/daemon-status on each tunnel HELLO
-- and on cert rotation. .com keys this by the registered server
-- identity (one row per pod). The pod-inventory handler joins this
-- against `servers` + `routing` to give the user authoritative
-- visibility into "what's claiming traffic under my username" — a
-- no-KYC alternative to CT-log monitoring (which would couple to
-- external infra and leak access patterns).
--
-- All cert-* and services_served_json fields are optional: a freshly
-- -installed daemon may not have a cert yet, and a daemon may report
-- HELLO without service metadata. Nullability lets readers fall back
-- to a "registered but not yet reporting" state instead of failing
-- closed.
CREATE TABLE IF NOT EXISTS daemon_status (
  server_domain TEXT PRIMARY KEY,
  cert_sha256 TEXT,
  cert_valid_until INTEGER,
  cert_issuer TEXT,
  services_served_json TEXT, -- JSON array of "serviceName@authorStableId"
  last_reported INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daemon_status_reported
  ON daemon_status(last_reported);
