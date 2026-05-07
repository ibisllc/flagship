-- Per-user revocation lists for entitlement certs (N12c).
--
-- The phone POSTs an IRK-signed `EntitlementRevocationList` to
-- /api/cert-revocations whenever it revokes a cert (compromised pod,
-- soft revoke after uninstall, etc.). One row per user — the latest
-- list replaces the previous, atomically. issuedAt is monotonic per
-- user; older lists are rejected at the handler layer.
--
-- .services pulls /api/cert-revocations/<username> with a 5-min cache;
-- on every HELLO it checks whether either the root cert or app cert
-- id is in the user's current list. The IRK signature is held alongside
-- the JSON body so .services can re-verify locally without trusting
-- the Worker as an oracle.

CREATE TABLE IF NOT EXISTS entitlement_revocation_lists (
  username             TEXT PRIMARY KEY,
  cert_ids_json        TEXT NOT NULL,
  irk_signature_hex    TEXT NOT NULL,
  issued_at            INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
