// Account-wide TLS-certificate validity window (days).
//
// The dead-man's-switch: how long a server your devices manage keeps serving
// before its certificate lapses if no admin device surfaces to renew. Set once
// (in Settings) and stamped into each managed server's signed blob at creation
// as `offlineWindowDays` — the wire format still carries it per-blob, so each
// grant *could* differ; we just don't surface that. Default 30 days.
//
// Mirrors the iOS `CertValidityStore` (UserDefaults). Stored in localStorage;
// reads/writes are guarded so a non-DOM context (tests) falls back to default.

export const CERT_VALIDITY_OPTIONS = [7, 30, 90];
export const DEFAULT_CERT_VALIDITY_DAYS = 30;

const KEY = "flagship.cert.validityDays";

export function getCertValidityDays() {
  try {
    const raw = parseInt(localStorage.getItem(KEY) ?? "", 10);
    return CERT_VALIDITY_OPTIONS.includes(raw) ? raw : DEFAULT_CERT_VALIDITY_DAYS;
  } catch {
    return DEFAULT_CERT_VALIDITY_DAYS;
  }
}

export function setCertValidityDays(days) {
  const v = CERT_VALIDITY_OPTIONS.includes(days) ? days : DEFAULT_CERT_VALIDITY_DAYS;
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* non-DOM context — nothing to persist */
  }
  return v;
}
