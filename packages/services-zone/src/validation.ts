/**
 * DNS-label validation for `<user>` and `<app>` parts of
 * `<app>.<user>.flagship.services`.
 *
 * Reserved names cover anything Flagship operates directly (so a user can't
 * claim "api" and shadow flagshipserver.com routes), plus a small list of
 * names commonly mistaken for system endpoints.
 */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_USER_LABELS = new Set([
  "api",
  "www",
  "admin",
  "administrator",
  "root",
  "support",
  "help",
  "billing",
  "payment",
  "auth",
  "login",
  "signup",
  "register",
  "flagship",
  "flagshipserver",
  "flagship-services",
  "service",
  "services",
  "status",
  "ops",
  "ns1",
  "ns2",
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "static",
  "cdn",
  "assets",
  "files",
  "git",
  "tunnel",
  "control",
  "control-plane",
  "console",
  "dashboard",
  "blog",
  "docs",
]);

export type LabelValidation =
  | { ok: true; label: string }
  | { ok: false; reason: string };

export function validateUserLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!LABEL_RE.test(norm)) {
    return {
      ok: false,
      reason: "username must match RFC 1035 label rules (1–63 chars, [a-z0-9-], not starting/ending with hyphen)",
    };
  }
  if (RESERVED_USER_LABELS.has(norm)) {
    return { ok: false, reason: `username "${norm}" is reserved` };
  }
  return { ok: true, label: norm };
}

export function validateAppLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!LABEL_RE.test(norm)) {
    return {
      ok: false,
      reason: "app subdomain must match RFC 1035 label rules",
    };
  }
  return { ok: true, label: norm };
}

/**
 * Builds the wildcard SAN list for a user's per-user cert. We always issue
 * for both `<user>.flagship.services` (the apex of their namespace) and
 * `*.<user>.flagship.services` (covers all per-app subdomains).
 */
export function userWildcardSans(username: string, apex: string): string[] {
  return [`${username}.${apex}`, `*.${username}.${apex}`];
}

export const _internal = { LABEL_RE, RESERVED_USER_LABELS };
