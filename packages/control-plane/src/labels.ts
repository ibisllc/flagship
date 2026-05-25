/**
 * RFC 1035 label validation and the reserved-username list.
 * Mirror of @flagship/services-zone validateUserLabel — hoisted here so
 * the control-plane package has zero runtime deps on Node-specific code.
 */

// Usernames: lowercase alphanumerics only, 3–30 chars. NO hyphens —
// this is deliberate. Banning '-' from usernames means the composite
// app id `<creator>-<slug>` parses unambiguously by splitting at the
// FIRST hyphen (the creator can't contain one), and the URL label
// `<slug>-<creator>` parses by splitting at the LAST hyphen (slugs
// may contain hyphens, creators can't). See docs/multi-device.md.
const USERNAME_RE = /^[a-z0-9]{3,30}$/;

// App slugs / pod names / arbitrary DNS labels follow RFC 1123
// (hyphens allowed in the interior, not at the ends, 1–63). Both
// validateAppLabel and validateServerLabel use this; usernames do NOT.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_USER_LABELS = new Set([
  "api", "www", "admin", "administrator", "root", "support", "help",
  "billing", "payment", "auth", "login", "signup", "register",
  "flagship", "flagshipserver", "flagship-services", "service", "services",
  "status", "ops", "ns1", "ns2", "mail", "email", "smtp", "imap", "pop",
  "static", "cdn", "assets", "files", "git", "tunnel", "control",
  "control-plane", "console", "dashboard", "blog", "docs",
]);

// Server (pod) labels are the leftmost segment of
// `<server>.<user>.flagship.services`. They are a standard RFC-1123 DNS
// label (lowercase letters/digits, interior hyphens allowed, no
// leading/trailing hyphen, 1–63) — see validateServerLabel. Hyphens are
// SAFE here because a server name is never composed with an app-name the
// way a username is, so `media-server` and friends should be allowed.
// The reserved set is narrower than the username set: most
// username-reserved words are about shadowing flagshipserver.com's APEX
// routes, which a server can't reach (it lives one label deeper, under
// the user). We still bar the handful that would collide with the
// per-user/per-server DNS plumbing (apex aliases, the wildcard cert SAN
// words) or read as a system endpoint inside a user's namespace.
const RESERVED_SERVER_LABELS = new Set([
  "www", "api", "admin", "flagship", "flagshipserver", "services",
  "ns1", "ns2", "mail", "tunnel", "control", "status",
]);

// Test-account usernames live in a Worker secret (env.TEST_ACCOUNTS),
// not in the open-source code. The /api/users/check handler folds them
// into its reject list at request time — see usersCheck.ts. Keeping the
// list out of git means a curious user can't discover an active sandbox
// just by reading the repo.

export type LabelValidation =
  | { ok: true; label: string }
  | { ok: false; reason: string };

export function validateUserLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!USERNAME_RE.test(norm)) {
    return { ok: false, reason: "username must be 3–30 lowercase letters or digits (no hyphens)" };
  }
  if (RESERVED_USER_LABELS.has(norm)) {
    return { ok: false, reason: `username "${norm}" is reserved` };
  }
  return { ok: true, label: norm };
}

export function validateAppLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!LABEL_RE.test(norm)) {
    return { ok: false, reason: "label must match RFC 1035 rules" };
  }
  return { ok: true, label: norm };
}

/**
 * Validate a server (pod) name — the leftmost `<server>` label of
 * `<server>.<user>.flagship.services`. This is a standard RFC-1123 DNS
 * label: lowercase letters/digits with interior hyphens allowed (no
 * leading/trailing hyphen), 1–63 chars. Looser than {@link
 * validateUserLabel} ON PURPOSE — a server name is a standalone label
 * under the user and is never composed with an app-name the way a
 * username is, so hyphens are unambiguous here and `media-server` should
 * be accepted. The reserved set is narrower (a server lives one label
 * deeper than the apex routes a username could shadow).
 */
export function validateServerLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!LABEL_RE.test(norm)) {
    return { ok: false, reason: "server name must be a DNS label: 1–63 lowercase letters or digits, hyphens allowed between characters (not at the start or end)" };
  }
  if (RESERVED_SERVER_LABELS.has(norm)) {
    return { ok: false, reason: `server name "${norm}" is reserved` };
  }
  return { ok: true, label: norm };
}

export const _labelInternal = {
  LABEL_RE,
  USERNAME_RE,
  RESERVED_USER_LABELS,
  RESERVED_SERVER_LABELS,
};
