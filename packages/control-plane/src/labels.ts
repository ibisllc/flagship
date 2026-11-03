/**
 * RFC 1035 label validation and the reserved-username list.
 * Mirror of @flagship/services-zone validateUserLabel — hoisted here so
 * the control-plane package has zero runtime deps on Node-specific code.
 */
import { voiciNameKey, voiciNameProblem } from "@flagship/protocol";
import reservedNames from "./reservedNames.json" with { type: "json" };

// Usernames follow the voi.ci namespace format (docs/voici-namespace-spec.md D12, shared with custom link names):
// 3–63 of a-z 0-9 and -, no leading, trailing or double hyphen (`--` stays the slug↔creator delimiter,
// docs/service-addressing-double-dash.md), and may start with a digit (D5). One rule, `voiciNameProblem` in
// @flagship/protocol, so every client and the server agree.

/** Username SHAPE check only (the D12 format) — no reserved-word check. */
export function isValidUsernameShape(input: string): boolean {
  return voiciNameProblem(String(input)) === null;
}

/**
 * The reserved words (packages/control-plane/src/reservedNames.json, the one list): each is a `reserved` row of the
 * names registry, which is what refuses them and their look-alikes at claim time. The set is kept here too so a
 * caller without the registry still refuses them; compare with `isReservedName` (on the safety key).
 */
const RESERVED_USER_LABELS: ReadonlySet<string> = new Set(reservedNames.words);
const RESERVED_KEYS: ReadonlySet<string> = new Set(reservedNames.words.map((w) => voiciNameKey(w)));

/** True when `name` or a look-alike of it (same safety key) is a reserved word. */
export function isReservedName(name: string): boolean {
  return RESERVED_KEYS.has(voiciNameKey(name));
}

// App slugs / pod names / arbitrary DNS labels follow RFC 1123
// (hyphens allowed in the interior, not at the ends, 1–63). Both
// validateAppLabel and validateServerLabel use this; usernames do NOT.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

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
  // Gossip fan-out reserved names (Phase 4) — a server (the leftmost
  // `<server>` label) must not collide with the fleet-wide gossip addresses
  // either, so a box can never shadow `broadcast--<user>` routing.
  "broadcast", "servers", "all",
  // Reserved for the Android relay fallback (also a reserved name, reservedNames.json).
  "relay-fallback",
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
  if (!isValidUsernameShape(norm)) {
    return {
      ok: false,
      reason:
        "username must be 3–63 lowercase letters/digits with interior single dashes (no leading/trailing or double dash)",
    };
  }
  if (isReservedName(norm)) {
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
  RESERVED_USER_LABELS,
  RESERVED_SERVER_LABELS,
};
