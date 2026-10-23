/**
 * The admin's once-per-server permission for a box to hold a certificate for every app name on the
 * account (`*.<username>.<apex>`), so whichever of the owner's servers the relay routes an app's
 * canonical name to can answer it with its own key. One certificate per box, key never copied.
 *
 *   flagship/server-wildcard-grant/v1|<username>|<serverDomain>|<stkPubHex>|<issuedAt>
 *
 * Signed by the account's sensitive-order key (the admin root where the account pins one, else the
 * IRK). It names the server AND the identity key it registered, so a later server under a reused
 * name never inherits it. `.com` checks it on each DNS-01 write for `_acme-challenge.<username>.<apex>`
 * and stores nothing; revoking the server ends it.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_SERVER_WILDCARD_GRANT = "flagship/server-wildcard-grant/v1";

export interface ServerWildcardGrant {
  username: string;
  serverDomain: string;
  /** The server's registered identity key (STK), 64 lowercase hex. */
  stkPubHex: string;
  issuedAt: number;
}

export function canonicalServerWildcardGrant(g: ServerWildcardGrant): Bytes {
  legacyFieldGuard("username", g.username);
  legacyFieldGuard("serverDomain", g.serverDomain);
  if (!/^[0-9a-f]{64}$/.test(g.stkPubHex)) throw new Error("stkPubHex must be 64 lowercase hex");
  const user = g.username.toLowerCase();
  const domain = g.serverDomain.toLowerCase();
  if (!domain.includes(`.${user}.`)) throw new Error("the server is not on this account");
  if (!Number.isSafeInteger(g.issuedAt) || g.issuedAt < 0) throw new Error("bad issuedAt");
  return new TextEncoder().encode([TAG_SERVER_WILDCARD_GRANT, user, domain, g.stkPubHex, g.issuedAt].join("|"));
}

export function signServerWildcardGrant(g: ServerWildcardGrant, sign: (msg: Bytes) => Bytes): Bytes {
  return sign(canonicalServerWildcardGrant(g));
}

export function verifyServerWildcardGrant(g: ServerWildcardGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServerWildcardGrant(g), pub);
  } catch {
    return false;
  }
}

/** The certificate name the grant covers. */
export function accountWildcardName(username: string, apex: string): string {
  return `*.${username.toLowerCase()}.${apex.toLowerCase()}`;
}
