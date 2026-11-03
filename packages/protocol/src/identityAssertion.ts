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
// keyd also refuses evidence the owner has since taken back, from what it keeps itself of the
// owner's signed revocations and rank orders (`held`, keyd's revocations.json): a revoked grant or
// device key, or a later order for the same target in this app. keyd learns those only when the
// daemon hands them over, so a daemon can withhold one it has not passed on yet, but never forge
// one or roll back one keyd holds. A statement dated more than the clock skew ahead is refused.

export type MasterEvidenceRefusal =
  | "not-master"
  | "bad-evidence"
  | "wrong-app"
  | "wrong-member"
  | "wrong-key"
  | "not-admin"
  | "expired"
  | "future"
  | "bad-signature"
  | "revoked"
  | "superseded";

/**
 * What keyd keeps of the owner's revocations and rank orders: revoked grant ids, revoked device
 * keys, and the latest rank order per `<appId>|<target>` (a tie keeps the one that is not master).
 */
export interface HeldRevocations {
  grants?: readonly string[];
  keys?: readonly string[];
  ranks?: Readonly<Record<string, { issuedAt: number; rank: string }>>;
}

export const MASTER_EVIDENCE_SKEW_MS = 5 * 60_000;

export interface MasterEvidence {
  appId: string;
  /** The key the member id is derived from (an account device's is the owner's AID: one person, many devices). */
  identityPubHex: string;
  /** The key the owner's statement names (the device that signed in); the identity key when omitted. */
  signInPubHex?: string;
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
  held: HeldRevocations = {},
): MasterEvidenceRefusal | null {
  const a = assertedIdentity(text);
  if (!a || a.role !== "master") return "not-master";
  if (typeof ev?.appId !== "string" || !FIELD.test(ev.appId) || typeof ev.identityPubHex !== "string" || !HEX32.test(ev.identityPubHex)) return "bad-evidence";
  if (typeof ev.statement !== "string" || ev.statement.length > 4096 || typeof ev.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(ev.signatureHex)) return "bad-evidence";
  if (a.app !== null && a.app !== ev.appId) return "wrong-app";
  const pub = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pub[i] = parseInt(ev.identityPubHex.slice(2 * i, 2 * i + 2), 16);
  if (stableIdOf(ev.appId, pub) !== a.user) return "wrong-member";
  if (ev.signInPubHex !== undefined && (typeof ev.signInPubHex !== "string" || !HEX32.test(ev.signInPubHex))) return "bad-evidence";
  const key = ev.signInPubHex ?? ev.identityPubHex;
  const root = anchors.adminRootPubHex && HEX32.test(anchors.adminRootPubHex) ? anchors.adminRootPubHex : null;
  const signer = root ?? anchors.irkPubHex;
  const p = ev.statement.split("|");
  let target: string;
  let issuedAt: number | null = null;
  if (p[0] === "flagship/device-capability-grant/v2") {
    if (p.length !== 8) return "bad-evidence";
    if (p[4] !== key) return "wrong-key";
    if (root && !p[5]!.split(",").includes("admin")) return "not-admin";
    if (!TIME.test(p[7]!) || Number(p[7]) <= now) return "expired";
    if (!TIME.test(p[6]!)) return "bad-evidence";
    if (Number(p[6]) > now + MASTER_EVIDENCE_SKEW_MS) return "future";
    target = `device:${key}`;
  } else if (p[0] === "flagship/app-rank/v1") {
    if (p.length !== 5) return "bad-evidence";
    if (p[1] !== ev.appId) return "wrong-app";
    if (p[2] !== `device:${key}` && p[2] !== `aid:${key}` && p[2] !== `aid:${ev.identityPubHex}`) return "wrong-key";
    if (p[3] !== "master") return "not-admin";
    if (!TIME.test(p[4]!)) return "bad-evidence";
    issuedAt = Number(p[4]);
    if (issuedAt > now + MASTER_EVIDENCE_SKEW_MS) return "future";
    target = p[2]!;
  } else {
    return "bad-evidence";
  }
  if (!verify(ev.signatureHex, new TextEncoder().encode(ev.statement), signer)) return "bad-signature";
  const targetKey = target.slice(target.indexOf(":") + 1);
  if ((p[0] === "flagship/device-capability-grant/v2" && held.grants?.includes(p[1]!)) || held.keys?.includes(targetKey)) return "revoked";
  const latest = Object.prototype.hasOwnProperty.call(held.ranks ?? {}, `${ev.appId}|${target}`) ? held.ranks![`${ev.appId}|${target}`]! : null;
  if (!latest) return null;
  if (issuedAt === null) return latest.rank === "master" ? null : "superseded";
  return latest.issuedAt > issuedAt || (latest.issuedAt === issuedAt && latest.rank !== "master") ? "superseded" : null;
}

// ── what keyd keeps of the owner's revocations and rank orders ─────────────────────────────────
//
// keyd's `evidence.note`: the daemon hands keyd each owner-signed revocation and rank order it
// accepts, and keyd keeps the ones that verify under the anchors in owner.json. A revocation
// (`flagship/revoke-device-capability-grant/v1`) must be the admin root's, as on the box
// (deviceRevocations.ts); with the revoked grant beside it (verified under the admin root or the
// IRK) keyd also keeps the device key. A rank order (`flagship/app-rank/v1`) must be the admin
// root's (the IRK's where none is pinned); keyd keeps the latest per app and target.

export type RevocationNoteRefusal = "bad-statement" | "no-admin-root" | "future" | "bad-signature" | "wrong-grant" | "full";

export interface RevocationNote {
  statement: string;
  signatureHex: string;
  grantStatement?: string;
  grantSignatureHex?: string;
}

export interface HeldRevocationsState {
  grants: string[];
  keys: string[];
  ranks: Record<string, { issuedAt: number; rank: string }>;
}

export const HELD_REVOCATIONS_MAX = { grants: 4096, keys: 4096, ranks: 16384 } as const;

const GRANT_ID = /^[0-9a-zA-Z-]{8,64}$/;
const REVOKE_REASONS = new Set(["lost", "stolen", "decommissioned", "replaced"]);
const RANK_TARGET = /^(device:[0-9a-f]{64}|aid:[0-9a-f]{64}|share:[0-9a-f]{32}|invite:[A-Za-z0-9._-]{1,128}|grant:[A-Za-z0-9._-]{1,128}\/[0-9a-f]{64})$/;
const RANKS = new Set(["member", "manager", "master", "refused"]);
const SIG = /^[0-9a-f]{128}$/;

/** The held state in its one stored form: sorted ids and keys, ranks by sorted key. */
export function normalizeHeldRevocations(h: HeldRevocations): HeldRevocationsState {
  const ranks: HeldRevocationsState["ranks"] = {};
  for (const k of Object.keys(h.ranks ?? {}).sort()) ranks[k] = { issuedAt: h.ranks![k]!.issuedAt, rank: h.ranks![k]!.rank };
  return { grants: [...new Set(h.grants ?? [])].sort(), keys: [...new Set(h.keys ?? [])].sort(), ranks };
}

/**
 * Take one owner-signed revocation or rank order into `held`: the new state and whether it
 * changed, or why not. Never throws.
 */
export function noteRevocation(
  held: HeldRevocations,
  note: RevocationNote,
  anchors: { irkPubHex: string; adminRootPubHex?: string | null },
  now: number,
  verify: (sigHex: string, msg: Uint8Array, pubHex: string) => boolean,
): { held: HeldRevocationsState; changed: boolean } | RevocationNoteRefusal {
  const st = note.statement;
  if (typeof st !== "string" || st.length > 4096 || typeof note.signatureHex !== "string" || !SIG.test(note.signatureHex)) return "bad-statement";
  const withGrant = note.grantStatement !== undefined || note.grantSignatureHex !== undefined;
  if (withGrant && (typeof note.grantStatement !== "string" || note.grantStatement.length > 4096 || typeof note.grantSignatureHex !== "string" || !SIG.test(note.grantSignatureHex))) {
    return "bad-statement";
  }
  const root = anchors.adminRootPubHex && HEX32.test(anchors.adminRootPubHex) ? anchors.adminRootPubHex : null;
  const enc = (t: string) => new TextEncoder().encode(t);
  const out = normalizeHeldRevocations(held);
  const p = st.split("|");
  if (p[0] === "flagship/revoke-device-capability-grant/v1") {
    if (p.length !== 5 || !GRANT_ID.test(p[1]!) || !p[2] || !REVOKE_REASONS.has(p[3]!) || !TIME.test(p[4]!)) return "bad-statement";
    if (Number(p[4]) > now + MASTER_EVIDENCE_SKEW_MS) return "future";
    if (!root) return "no-admin-root";
    if (!verify(note.signatureHex, enc(st), root)) return "bad-signature";
    let key: string | null = null;
    if (withGrant) {
      const g = note.grantStatement!.split("|");
      if (g[0] !== "flagship/device-capability-grant/v2" || g.length !== 8 || !HEX32.test(g[4]!)) return "bad-statement";
      if (g[1] !== p[1]) return "wrong-grant";
      if (!verify(note.grantSignatureHex!, enc(note.grantStatement!), root) && !verify(note.grantSignatureHex!, enc(note.grantStatement!), anchors.irkPubHex)) return "bad-signature";
      key = g[4]!;
    }
    const newGrant = !out.grants.includes(p[1]!);
    const newKey = key !== null && !out.keys.includes(key);
    if ((newGrant && out.grants.length >= HELD_REVOCATIONS_MAX.grants) || (newKey && out.keys.length >= HELD_REVOCATIONS_MAX.keys)) return "full";
    if (newGrant) out.grants = [...out.grants, p[1]!].sort();
    if (newKey) out.keys = [...out.keys, key!].sort();
    return { held: out, changed: newGrant || newKey };
  }
  if (p[0] === "flagship/app-rank/v1") {
    if (p.length !== 5 || !FIELD.test(p[1]!) || !RANK_TARGET.test(p[2]!) || !RANKS.has(p[3]!) || !TIME.test(p[4]!)) return "bad-statement";
    const at = Number(p[4]);
    if (at > now + MASTER_EVIDENCE_SKEW_MS) return "future";
    if (!verify(note.signatureHex, enc(st), root ?? anchors.irkPubHex)) return "bad-signature";
    const k = `${p[1]}|${p[2]}`;
    const cur = Object.prototype.hasOwnProperty.call(out.ranks, k) ? out.ranks[k]! : null;
    if (cur && (cur.issuedAt > at || (cur.issuedAt === at && (cur.rank !== "master" || p[3] === "master")))) return { held: out, changed: false };
    if (!cur && Object.keys(out.ranks).length >= HELD_REVOCATIONS_MAX.ranks) return "full";
    out.ranks[k] = { issuedAt: at, rank: p[3]! };
    return { held: normalizeHeldRevocations(out), changed: true };
  }
  return "bad-statement";
}
