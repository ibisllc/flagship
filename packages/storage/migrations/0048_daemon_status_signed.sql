-- Cert-fingerprint pinning (cert-model A′, phase 4a): persist the VERBATIM
-- STK-signed daemon-status tuple + its signature so /pods can relay the RAW
-- signed report. A phone derives the box STK locally
-- (deriveSTK(deriveSWK(UMK, serverId))) and re-verifies the leaf-cert
-- fingerprint end-to-end — .com relays the fingerprint but cannot forge it.
--
-- report_json   the exact signed field tuple as received (JSON object:
--               serverDomain, certSha256, certValidUntil, certIssuer,
--               appsServed, nonce, issuedAt) — what the canonical bytes are
--               rebuilt from on re-verification.
-- signature_hex Ed25519 signature (hex) over the report's canonical bytes
--               (flagship/daemon-status/v1), by the box identity (STK) key.
--
-- Nullable: rows written before this migration carry no signed report.

ALTER TABLE daemon_status ADD COLUMN report_json TEXT;
ALTER TABLE daemon_status ADD COLUMN signature_hex TEXT;
