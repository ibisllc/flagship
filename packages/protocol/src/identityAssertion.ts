/**
 * The identity a box asserts to its own apps (docs/app-apis.md §5): `flagship/inject/v1` on every
 * proxied request and the older `flagship/identity-header/v1`. The box signs them with its STK,
 * so whoever can ask keyd for a signature could otherwise name any user at any rank. These checks
 * fix what a well-formed assertion may say, and keyd (TS and Rust) refuses anything else:
 *
 *   flagship/inject/v1|<appId>|<user>|<role>|<ms>[|<scope>]
 *     role member | manager | master: a member's per-app id (never `anonymous`, never `apikey:`)
 *     role anonymous: user `anonymous`, nothing more
 *     role api: user `apikey:<keyId>`, and the key's scope (`read` | `write`) as a sixth field
 *   flagship/identity-header/v1|<member>|<role>|<ms>
 *     role member | manager | master with a member id, or `anonymous|anonymous`
 *
 * There is no owner rank and no other role (AGENTS.md "Three ranks"). Which rank a visitor holds
 * is the box's verified access state (serviceAccess.ts); this module only fixes the shapes, so a
 * forged role such as `owner` or `admin`, an anonymous visitor with a rank, or an API key with a
 * member's rank never gets a box signature. Vectors: test-vectors/identity-assertion/.
 */
export const TAG_INJECT = "flagship/inject/v1";
export const TAG_IDENTITY_HEADER = "flagship/identity-header/v1";
export const ASSERTED_RANKS = ["member", "manager", "master"] as const;
export type AssertedRank = (typeof ASSERTED_RANKS)[number];

export type IdentityAssertionRefusal =
  | "not-an-assertion"
  | "bad-shape"
  | "bad-app"
  | "bad-user"
  | "bad-role"
  | "bad-time"
  | "bad-scope";

const FIELD = /^[\x21-\x7e]{1,128}$/;
const TIME = /^(0|[1-9][0-9]{0,15})$/;
const API_USER = /^apikey:[A-Za-z0-9_-]{1,64}$/;

export function isAssertedRank(r: unknown): r is AssertedRank {
  return typeof r === "string" && (ASSERTED_RANKS as readonly string[]).includes(r);
}

function checkUserRole(user: string, role: string, apiAllowed: boolean): IdentityAssertionRefusal | null {
  if (!FIELD.test(user)) return "bad-user";
  if (role === "anonymous") return user === "anonymous" ? null : "bad-user";
  if (role === "api") {
    if (!apiAllowed) return "bad-role";
    return API_USER.test(user) ? null : "bad-user";
  }
  if (!isAssertedRank(role)) return "bad-role";
  if (user === "anonymous" || user.startsWith("apikey:")) return "bad-user";
  return null;
}

/**
 * Null when `msg` is a well-formed identity assertion (or not one at all: the caller decides
 * what other purposes may be signed), else why it is refused. Used by keyd before it signs.
 */
export function checkIdentityAssertion(msg: Uint8Array | string): IdentityAssertionRefusal | null {
  const text = typeof msg === "string" ? msg : new TextDecoder("utf-8", { fatal: false }).decode(msg);
  const parts = text.split("|");
  if (parts[0] === TAG_INJECT) {
    if (parts.length !== 5 && parts.length !== 6) return "bad-shape";
    const [, app, user, role, ts, scope] = parts as [string, string, string, string, string, string | undefined];
    if (!FIELD.test(app)) return "bad-app";
    const ur = checkUserRole(user, role, true);
    if (ur) return ur;
    if (!TIME.test(ts)) return "bad-time";
    if (role === "api") return scope === "read" || scope === "write" ? null : "bad-scope";
    return scope === undefined ? null : "bad-shape";
  }
  if (parts[0] === TAG_IDENTITY_HEADER) {
    if (parts.length !== 4) return "bad-shape";
    const [, user, role, ts] = parts as [string, string, string, string];
    const ur = checkUserRole(user, role, false);
    if (ur) return ur;
    return TIME.test(ts) ? null : "bad-time";
  }
  return "not-an-assertion";
}

// ── master needs the owner's evidence (pq-suites.md §16.6, milestone 6) ──────────────────────
//
// keyd cannot see the box's access state, so a compromised daemon could ask it to sign `master`
// for any real member's id. keyd therefore signs a `master` assertion only with evidence it checks
// itself against the owner anchors root pinned at the boot ceremony (`owner.json`):
//   - the user field is the per-app id of `identityPubHex` for this app, derived in keyd from the
//     SWK it holds (deriveServiceMemberStableId(deriveServiceSecret(swk, appId), identityPub));
//   - and either the owner's device grant for that very key
//     (`flagship/device-capability-grant/v2|…`, with the `admin` scope under the admin root; under
//     the IRK on a box with no admin root), unexpired, or an admin order raising that key to master
//     in this app (`flagship/app-rank/v1|<appId>|device:<key>|master|…` or `aid:<key>`).
// What keyd still cannot see: a later demotion order or a revoked grant (no journal in keyd).

export type MasterEvidenceRefusal =
  | "not-master"
  | "bad-evidence"
  | "wrong-app"
  | "wrong-member"
  | "wrong-key"
  | "not-admin"
  | "expired"
  | "bad-signature";

export interface MasterEvidence {
  appId: string;
  identityPubHex: string;
  statement: string;
  signatureHex: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

/** The asserted app, user and role of an identity assertion; null when it is not one. */
export function assertedIdentity(text: string): { app: string | null; user: string; role: string } | null {
  if (checkIdentityAssertion(text) !== null) return null;
  const p = text.split("|");
  return p[0] === TAG_INJECT ? { app: p[1]!, user: p[2]!, role: p[3]! } : { app: null, user: p[1]!, role: p[2]! };
}

/**
 * Null when `ev` makes the master assertion `text` true, else why not. `stableIdOf(appId, pub)`
 * is keyd's own derivation; `verify(sig, msg, pubHex)` its Ed25519 check.
 */
export function checkMasterEvidence(
  text: string,
  ev: MasterEvidence,
  anchors: { irkPubHex: string; adminRootPubHex?: string | null },
  now: number,
  stableIdOf: (appId: string, identityPub: Uint8Array) => string,
  verify: (sigHex: string, msg: Uint8Array, pubHex: string) => boolean,
): MasterEvidenceRefusal | null {
  const a = assertedIdentity(text);
  if (!a || a.role !== "master") return "not-master";
  if (typeof ev?.appId !== "string" || !FIELD.test(ev.appId) || typeof ev.identityPubHex !== "string" || !HEX32.test(ev.identityPubHex)) return "bad-evidence";
  if (typeof ev.statement !== "string" || ev.statement.length > 4096 || typeof ev.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(ev.signatureHex)) return "bad-evidence";
  if (a.app !== null && a.app !== ev.appId) return "wrong-app";
  const pub = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pub[i] = parseInt(ev.identityPubHex.slice(2 * i, 2 * i + 2), 16);
  if (stableIdOf(ev.appId, pub) !== a.user) return "wrong-member";
  const root = anchors.adminRootPubHex && HEX32.test(anchors.adminRootPubHex) ? anchors.adminRootPubHex : null;
  const signer = root ?? anchors.irkPubHex;
  const p = ev.statement.split("|");
  if (p[0] === "flagship/device-capability-grant/v2") {
    if (p.length !== 8) return "bad-evidence";
    if (p[4] !== ev.identityPubHex) return "wrong-key";
    if (root && !p[5]!.split(",").includes("admin")) return "not-admin";
    if (!/^(0|[1-9][0-9]{0,15})$/.test(p[7]!) || Number(p[7]) <= now) return "expired";
  } else if (p[0] === "flagship/app-rank/v1") {
    if (p.length !== 5) return "bad-evidence";
    if (p[1] !== ev.appId) return "wrong-app";
    if (p[2] !== `device:${ev.identityPubHex}` && p[2] !== `aid:${ev.identityPubHex}`) return "wrong-key";
    if (p[3] !== "master") return "not-admin";
  } else {
    return "bad-evidence";
  }
  return verify(ev.signatureHex, new TextEncoder().encode(ev.statement), signer) ? null : "bad-signature";
}
