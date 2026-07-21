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
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
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
  // Test-environment apex labels (docs/ui-test-gym.md §6.5) — mirror of
  // control-plane labels.ts. Banning these as usernames keeps the `gym.`
  // test env from ever colliding with a real user's identity or zone.
  "gym",
  "test",
  "e2e",
  "qa",
  "ci",
  "staging",
  // Per-account gossip fan-out reserved names (Phase 4) — mirror of
  // control-plane labels.ts. `broadcast` is the reserved fan-out label
  // `broadcast--<user>.flagship.services` the hub mirrors gossip through;
  // `servers`/`all` are reserved collective addresses for the same regime.
  "broadcast",
  "servers",
  "all",
]);

export type LabelValidation =
  | { ok: true; label: string }
  | { ok: false; reason: string };

export function validateUserLabel(input: string): LabelValidation {
  const norm = String(input).toLowerCase();
  if (!USERNAME_RE.test(norm) || norm.includes("--")) {
    return {
      ok: false,
      reason: "username must be 3–30 lowercase letters/digits with interior single dashes (no leading/trailing or double dash — `--` is the slug-creator separator)",
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
 * Validate the leftmost DNS label of a QUALIFIED app URL — for an app authored
 * by `<creator>`, this is `<slug>--<creator>` (docs/service-addressing-double-dash.md).
 * Both halves may carry interior single dashes; the single `--` is the boundary.
 * (A bare self-authored `<slug>` has no creator suffix and is not a parse target.)
 */
export function parseAppLabel(label: string): { slug: string; creator: string } | { ok: false; reason: string } {
  const norm = String(label).toLowerCase();
  // Split on the single `--` delimiter. Both slug and creator forbid `--`, so
  // there is exactly one — the unambiguous slug/creator boundary.
  const parts = norm.split("--");
  if (parts.length !== 2) {
    return { ok: false, reason: "app label must be <slug>--<creator>" };
  }
  const slug = validateAppSlug(parts[0]!);
  if (!slug.ok) return { ok: false, reason: `bad slug part: ${slug.reason}` };
  const creator = validateUserLabel(parts[1]!);
  if (!creator.ok) return { ok: false, reason: `bad creator part: ${creator.reason}` };
  return { slug: slug.label, creator: creator.label };
}

/**
 * The class a leftmost label resolves to under the ONE per-user resolver.
 * App labels and box-coordination names share the same
 * `*.<user>` leftmost-label space and MUST be mutually unique within a user
 * (the storage invariant); this resolver applies the deterministic
 * PRECEDENCE so the class is well-defined even if that invariant is ever
 * momentarily violated.
 *
 * The `--` pin operator (`<label>--<server>`) is RETIRED (A′ migration):
 * box-pinned access is simply the hierarchical canonical name
 * `<service>.<server>.<user>.flagship.services`, which lives under the BOX
 * zone and is routed by its `<server>.<user>` suffix — it never reaches
 * this user-zone resolver.
 */
export type LabelClass = "box-apex" | "app" | "none";

export interface ResolverLookups {
  /** Is `label` a registered box (server) name for this user? */
  isBoxName(label: string): boolean;
  /** Is `label` an app installed in this user's install table? */
  isAppLabel(label: string): boolean;
}

export interface ResolvedLabel {
  cls: LabelClass;
  /** The input label (lowercased). */
  label: string;
}

/**
 * The per-user leftmost-label resolver (names directly under the USER zone,
 * i.e. tier 2 `<label>.<user>.flagship.services`). Resolution PRECEDENCE:
 *   1. registered box name → box-coordination apex (`/.flagship/*`).
 *   2. in the install table → leader-route to that service (tier 2,
 *      hardware-agnostic).
 *   3. else → the disambiguation / "not an app" page.
 *
 * Box-pinned access is NOT a tier here: it is the hierarchical canonical
 * name `<service>.<server>.<user>` under the box zone, routed by suffix
 * before any leftmost-label resolution happens.
 *
 * Returns `(cls, label)`, NOT just a route, so each caller applies the
 * correct security/capability context for the class (red-team C3).
 */
export function resolveLeftmostLabel(leftmostLabel: string, lookups: ResolverLookups): ResolvedLabel {
  const norm = String(leftmostLabel).toLowerCase();
  if (lookups.isBoxName(norm)) return { cls: "box-apex", label: norm };
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
 * Per-box wildcard SAN list — the CANONICAL cert shape under model A′. Each
 * box mints its OWN cert (box-local key, never shared) covering the box apex
 * `<server>.<user>.<apex>` plus everything one label under it
 * (`*.<server>.<user>.<apex>`), i.e. every canonical service name
 * `<service>.<server>.<user>.<apex>`. The names are distinct per box, so
 * issuance never trips Let's Encrypt's duplicate-certificate limit.
 *
 * Tier-2 names (`<service>.<user>.<apex>`, hardware-agnostic, leader-routed)
 * are NOT covered here — they get a shared per-service cert delivered over
 * the box's canonical pinned pipe (A′ Phase 5).
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
 * Tier-2 service FQDN: `<label>.<user>.<apex>` — the hardware-AGNOSTIC name.
 * The leader-selection harness picks which box answers; the cert is a shared
 * per-service cert, not the per-box wildcard.
 */
export function appFqdn(
  appSubdomain: string,
  username: string,
  apex: string,
): string {
  return `${appSubdomain}.${username}.${apex}`;
}

/**
 * Tier-1 canonical service FQDN: `<service>.<server>.<user>.<apex>` — the
 * hierarchical, box-PINNED name (security + hardware assurance). Covered by
 * the box's own wildcard cert (`serverWildcardSans`); routed by its
 * `<server>.<user>` suffix, so it never reaches the user-zone
 * leftmost-label resolver. Replaces the retired `--` pin operator.
 */
export function canonicalServiceFqdn(
  serviceLabel: string,
  serverName: string,
  username: string,
  apex: string,
): string {
  return `${serviceLabel}.${serverName}.${username}.${apex}`;
}

export const _internal = { LABEL_RE, USERNAME_RE, SLUG_RE, SLUG_MAX, RESERVED_USER_LABELS };
