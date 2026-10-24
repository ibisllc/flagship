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
