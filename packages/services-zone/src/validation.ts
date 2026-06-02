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
 * The `--` pin operator (per-user-cert design §3.3). A leftmost label of
 * the form `<label>--<server>` pins an app to a specific box — a rare
 * power-user / debug escape hatch, NOT the primary public form. Split on
 * the FIRST `--`: left = app label, right = box name.
 *
 * Returns the parsed halves, or `{ ok: false }` if `L` is not a pin label
 * or violates the dash rules. A plain label (no `--`) returns
 * `{ ok: false, reason: "not a pin label" }` — callers use `isPinLabel`
 * first, or treat that reason as "fall through to the normal resolver".
 *
 * Rules (§3.3):
 *   - The app part and the box part are each ordinary slugs, so neither may
 *     contain `--` (SLUG_RE already forbids doubled dashes) or a
 *     leading/trailing dash.
 *   - The segment before `--` must NOT be exactly 2 characters, and the
 *     whole label must NOT begin `xn--` — both collide with the IDN /
 *     punycode R-LDH reservation (RFC 5890: hyphens at character positions
 *     3–4 are reserved for A-labels).
 */
export function parsePinLabel(
  leftmostLabel: string,
): { ok: true; label: string; server: string } | { ok: false; reason: string } {
  const norm = String(leftmostLabel).toLowerCase();
  const idx = norm.indexOf("--");
  if (idx < 0) return { ok: false, reason: "not a pin label (no `--` operator)" };
  // R-LDH guard: a label beginning `xn--` is a reserved punycode A-label.
  if (norm.startsWith("xn--")) {
    return { ok: false, reason: "label must not begin `xn--` (RFC 5890 reservation)" };
  }
  const labelPart = norm.slice(0, idx);
  const serverPart = norm.slice(idx + 2);
  // R-LDH guard: a 2-char app part puts `--` at character positions 3–4.
  if (labelPart.length === 2) {
    return { ok: false, reason: "app part before `--` must not be exactly 2 characters" };
  }
  const app = validateAppSlug(labelPart);
  if (!app.ok) return { ok: false, reason: `bad app part: ${app.reason}` };
  // The box part must itself be a clean slug — this rejects a box name that
  // smuggles a second `--` (`app--box--extra` → serverPart `box--extra`).
  const box = validateAppSlug(serverPart);
  if (!box.ok) return { ok: false, reason: `bad box part: ${box.reason}` };
  return { ok: true, label: app.label, server: box.label };
}

/**
 * Cheap predicate: does this leftmost label use the `--` pin operator?
 * The §3.4 resolver checks this FIRST (step 1) before box-name / device /
 * install-table lookup.
 */
export function isPinLabel(leftmostLabel: string): boolean {
  return String(leftmostLabel).includes("--");
}

/**
 * The class a leftmost label resolves to under the §3.4 ONE per-user
 * resolver. App labels, box-coordination names, pin targets, and device
 * labels all share the same `*.<user>` leftmost-label space and MUST be
 * mutually unique within a user (the storage invariant); this resolver
 * applies the deterministic PRECEDENCE so the class is well-defined even
 * if that invariant is ever momentarily violated.
 */
export type LabelClass = "pin" | "box-apex" | "device" | "app" | "none";

export interface ResolverLookups {
  /** Is `label` a registered box (server) name for this user? */
  isBoxName(label: string): boolean;
  /** Is `label` a registered device label (v2 device-addressing)? */
  isDeviceLabel(label: string): boolean;
  /** Is `label` an app installed in this user's install table? */
  isAppLabel(label: string): boolean;
}

export interface ResolvedLabel {
  cls: LabelClass;
  /** For "pin": the app label; otherwise the input label (lowercased). */
  label: string;
  /** For "pin": the target box name. Absent otherwise. */
  server?: string;
}

/**
 * The §3.4 per-user leftmost-label resolver. Resolution PRECEDENCE:
 *   1. contains `--` → pin (`label--server`), route to that box.
 *   2. registered box name → box-coordination apex (`/.flagship/*`).
 *   3. registered device label → device view (capability scopes apply).
 *   4. in the install table → leader-route to that service.
 *   5. else → the disambiguation / "not an app" page.
 *
 * Returns `(cls, label, server?)`, NOT just a route, so each caller applies
 * the correct security/capability context for the class (red-team C3).
 */
export function resolveLeftmostLabel(leftmostLabel: string, lookups: ResolverLookups): ResolvedLabel {
  const norm = String(leftmostLabel).toLowerCase();
  if (isPinLabel(norm)) {
    const p = parsePinLabel(norm);
    if (!p.ok) return { cls: "none", label: norm };
    return { cls: "pin", label: p.label, server: p.server };
  }
  if (lookups.isBoxName(norm)) return { cls: "box-apex", label: norm };
  if (lookups.isDeviceLabel(norm)) return { cls: "device", label: norm };
  if (lookups.isAppLabel(norm)) return { cls: "app", label: norm };
  return { cls: "none", label: norm };
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
