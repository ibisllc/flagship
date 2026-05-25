/**
 * Validation for the labels that appear in
 * `<slug>-<creator>.<host>.flagship.services`.
 *
 * Two distinct label classes:
 *
 *   - **Username (creator + host):** `[a-z0-9]{3,30}` — dashless. The
 *     dash that separates `<slug>-<creator>` in app URLs is unambiguous
 *     only if usernames cannot contain dashes; the URL parser splits on
 *     the last dash to pull out `<creator>`. Usernames are short
 *     human-chosen handles where most people don't need dashes; the
 *     small UX cost is worth the parse simplicity.
 *
 *   - **App slug:** `[a-z0-9-]{1,32}` — dashes allowed but no leading,
 *     trailing, or doubled dashes. Slugs are routinely multi-word
 *     (`habit-tracker`, `password-manager`); making them dashless would
 *     impose a recurring tax on every app creation.
 *
 *   - **Store name** (in app data identity): `[a-z0-9]{1,32}` — dashless.
 *     Validated by the data-layer naming module; not exposed in DNS.
 *
 * Reserved names cover anything Flagship operates directly (so a user
 * can't claim "api" and shadow flagshipserver.com routes), plus a small
 * list of names commonly mistaken for system endpoints.
 */
// Canonical username rule (mirror of control-plane labels.ts): lower
// alphanumerics only, no hyphens, 3–30 chars. Hyphen-free usernames
// keep `<creator>-<slug>` app ids unambiguous.
const USERNAME_RE = /^[a-z0-9]{3,30}$/;
const SLUG_RE = /^[a-z0-9](-?[a-z0-9])*$/;
const SLUG_MAX = 32;
/** Legacy DNS label regex retained for callers that do raw subdomain validation. */
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
  if (!USERNAME_RE.test(norm)) {
    return {
      ok: false,
      reason: "username must match [a-z0-9]{3,30} (no dashes — the dash is reserved as the slug-creator separator in app URLs)",
    };
  }
  if (RESERVED_USER_LABELS.has(norm)) {
    return { ok: false, reason: `username "${norm}" is reserved` };
  }
  return { ok: true, label: norm };
}

/**
 * Validate an app slug — used both as the leftmost piece of the URL
 * (`<slug>-<creator>.<host>.flagship.services`) and as part of the
 * canonical data identity. Dashes allowed; no leading/trailing/doubled.
 */
export function validateAppSlug(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (norm.length < 1 || norm.length > SLUG_MAX || !SLUG_RE.test(norm)) {
    return {
      ok: false,
      reason: `app slug must match [a-z0-9-]{1,${SLUG_MAX}} with no leading/trailing/doubled dash`,
    };
  }
  return { ok: true, label: norm };
}

/**
 * Validate the leftmost DNS label of an app URL — for an app authored
 * by `<creator>`, this is `<slug>-<creator>`. The `<creator>` half is a
 * username so its rules apply (dashless); the `<slug>` half follows the
 * slug rules (dashes ok, no leading/trailing/double). Together they
 * have exactly one separating dash followed by the creator suffix.
 */
export function parseAppLabel(label: string): { slug: string; creator: string } | { ok: false; reason: string } {
  const norm = String(label).toLowerCase();
  // Find the LAST dash. Everything before is the slug; everything after is
  // the creator. This works because creators are dashless; the slug is
  // free to contain interior dashes.
  const idx = norm.lastIndexOf("-");
  if (idx < 0) {
    return { ok: false, reason: "app label must include a dash separating slug from creator" };
  }
  const slugPart = norm.slice(0, idx);
  const creatorPart = norm.slice(idx + 1);
  const slug = validateAppSlug(slugPart);
  if (!slug.ok) return { ok: false, reason: `bad slug part: ${slug.reason}` };
  const creator = validateUserLabel(creatorPart);
  if (!creator.ok) return { ok: false, reason: `bad creator part: ${creator.reason}` };
  return { slug: slug.label, creator: creator.label };
}

/**
 * Legacy validator kept for code paths that still treat the leftmost
 * subdomain as a single opaque DNS label (e.g., the cert plumbing).
 * Prefer `parseAppLabel` for app routing.
 */
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

export const _internal = { LABEL_RE, USERNAME_RE, SLUG_RE, SLUG_MAX, RESERVED_USER_LABELS };
