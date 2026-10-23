// `flagship/server-wildcard-grant/v1`: the admin's once-per-server permission for a box to hold a
// certificate for every app name on the account (`*.<user>.<apex>`). Signed with the sensitive-order key
// and sent to the box at POST /api/screens/server-wildcard-grant. Wire parity with
// packages/protocol/src/serverWildcardGrant.ts; pinned by packages/protocol/test-vectors/server-wildcard-grant/vectors.json.
//
//   flagship/server-wildcard-grant/v1|<username lowercase>|<serverDomain lowercase>|<stkPubHex>|<issuedAt>

export const SERVER_WILDCARD_GRANT_TAG = "flagship/server-wildcard-grant/v1";

const clean = (s) => typeof s === "string" && s.length > 0 && !/[|\x00-\x1f\x7f]/.test(s);

export function canonicalServerWildcardGrant(g) {
  if (!clean(g.username)) throw new Error("username");
  if (!clean(g.serverDomain)) throw new Error("serverDomain");
  if (typeof g.stkPubHex !== "string" || !/^[0-9a-f]{64}$/.test(g.stkPubHex)) throw new Error("stkPubHex");
  const user = g.username.toLowerCase();
  const domain = g.serverDomain.toLowerCase();
  if (!domain.includes(`.${user}.`)) throw new Error("the server is not on this account");
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("issuedAt");
  return new TextEncoder().encode([SERVER_WILDCARD_GRANT_TAG, user, domain, g.stkPubHex, g.issuedAt].join("|"));
}

/** The JSON body of POST /api/screens/server-wildcard-grant; `sign(bytes)` returns the 64-byte signature. */
export async function serverWildcardGrantBody(grant, sign) {
  const sig = await sign(canonicalServerWildcardGrant(grant));
  return { issuedAt: grant.issuedAt, signature: Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("") };
}
