/**
 * Server self-revocation — a daemon shedding its own subdomain
 * (`flagship/server-revoke-by-self/v1`), signed by the box's identity key.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tag, field
 * order, and guard are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * A server revoking *itself* — typically in response to a phone
 * `revoke-self` order or a local "I've been compromised" signal. The
 * IRK-signed `ServerRevocation` is the user's path; this is the
 * server's own.
 *
 * Trust model: if the server identity key is leaked, the attacker
 * could revoke the server. That's a small downside (denial of service
 * against the server's own subdomain) compared to the alternative of
 * not letting a daemon shed itself when it knows it should.
 */
export interface ServerRevokeBySelf {
  serverId: ServerId;
  reason: string;
  issuedAt: number;
}

const TAG_SERVER_REVOKE_BY_SELF = "flagship/server-revoke-by-self/v1";

function canonicalServerRevokeBySelf(r: ServerRevokeBySelf): Bytes {
  legacyFieldGuard("reason", r.reason);
  return new TextEncoder().encode(
    [TAG_SERVER_REVOKE_BY_SELF, r.serverId, r.reason, r.issuedAt].join("|"),
  );
}

export function signServerRevokeBySelf(r: ServerRevokeBySelf, identity: Keypair): Bytes {
  return ed.sign(canonicalServerRevokeBySelf(r), identity.privateKey);
}
export function verifyServerRevokeBySelf(r: ServerRevokeBySelf, sig: Bytes, identityPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalServerRevokeBySelf(r), identityPub);
  } catch {
    return false;
  }
}
