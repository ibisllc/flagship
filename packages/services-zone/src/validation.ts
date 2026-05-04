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
 * Per-user wildcard SAN list. Used when issuing a single cert that covers
 * the user's namespace apex plus a single layer of subdomains. SUPERSEDED
 * by `serverWildcardSans` for v1 (multi-server), kept for older callers.
 */
export function userWildcardSans(username: string, apex: string): string[] {
  return [`${username}.${apex}`, `*.${username}.${apex}`];
}

/**
 * Per-server wildcard SAN list. Each Flagship server gets its own cert
 * covering its own namespace under the user — `<server>.<user>.<apex>`
 * plus `*.<server>.<user>.<apex>` for app subdomains.
 *
 * This is the preferred shape for v1 (one user can run many servers).
 */
export function serverWildcardSans(
  serverName: string,
  username: string,
  apex: string,
): string[] {
  return [
    `${serverName}.${username}.${apex}`,
    `*.${serverName}.${username}.${apex}`,
  ];
}

/**
 * Build the FQDN for one app on one server. This is the canonical URL
 * construction the whole stack should call when it needs an app's address.
 */
export function appFqdn(
  appSubdomain: string,
  serverName: string,
  username: string,
  apex: string,
): string {
  return `${appSubdomain}.${serverName}.${username}.${apex}`;
}

export const _internal = { LABEL_RE, RESERVED_USER_LABELS };
