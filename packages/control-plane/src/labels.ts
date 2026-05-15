/**
 * RFC 1035 label validation and the reserved-username list.
 * Mirror of @flagship/services-zone validateUserLabel — hoisted here so
 * the control-plane package has zero runtime deps on Node-specific code.
 */

// Usernames: lowercase alphanumerics only, 1–63 chars. NO hyphens —
// this is deliberate. Banning '-' from usernames means the composite
// app id `<creator>-<slug>` parses unambiguously by splitting at the
// FIRST hyphen (the creator can't contain one), and the URL label
// `<slug>-<creator>` parses by splitting at the LAST hyphen (slugs
// may contain hyphens, creators can't). See docs/multi-device.md.
const USERNAME_RE = /^[a-z0-9]{1,63}$/;

// App slugs / pod names / arbitrary DNS labels still follow RFC 1035
// (hyphens allowed in the interior, not at the ends). validateAppLabel
// uses this; usernames do NOT.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_USER_LABELS = new Set([
  "api", "www", "admin", "administrator", "root", "support", "help",
  "billing", "payment", "auth", "login", "signup", "register",
  "flagship", "flagshipserver", "flagship-services", "service", "services",
  "status", "ops", "ns1", "ns2", "mail", "email", "smtp", "imap", "pop",
  "static", "cdn", "assets", "files", "git", "tunnel", "control",
  "control-plane", "console", "dashboard", "blog", "docs",
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
    return { ok: false, reason: "username must be 1–63 lowercase letters or digits (no hyphens)" };
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

export const _labelInternal = { LABEL_RE, USERNAME_RE, RESERVED_USER_LABELS };
