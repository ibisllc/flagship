-- Vulnerability reports from the website's form (POST /api/security/report, apps/com/src/securityReports.ts).
--
-- Everything the reporter typed (contact email, component, summary, details) is one OpenPGP message encrypted on
-- intake to the security key (apps/web/public/.well-known/pgp-key.txt), whose private half is only on YubiKeys:
-- `.com` and D1 never hold it in clear. In clear only: the id the reporter is shown, when it arrived, the severity
-- they picked, the plaintext's size, and whether the owner's notification email went out. No address or other
-- detail about the sender is stored (the rate limiter counts addresses in Durable Objects only).
--
-- triage: 1 when the report is also encrypted to the AI triage key (SECURITY_REPORT_TRIAGE_KEY), so
-- `npm run security-reports -- --triage` can open it; 0 for reports only the YubiKey key opens.
-- notify_status: 'pending' (stored, email not tried yet), 'sent', 'failed', 'skipped' (no email configured).
-- Read by GET /api/admin/security-reports and `npm run security-reports`.
--
-- Re-runnable (CREATE ... IF NOT EXISTS only). Apply before the `.com` deploy that carries the route: without the
-- table every report answers 500 and the page falls back to the email address.
CREATE TABLE IF NOT EXISTS security_reports (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  triage INTEGER NOT NULL DEFAULT 0,
  notify_status TEXT NOT NULL DEFAULT 'pending',
  notify_at INTEGER
);

CREATE INDEX IF NOT EXISTS security_reports_received ON security_reports (received_at);
