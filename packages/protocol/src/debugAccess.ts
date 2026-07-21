/**
 * Owner-authorized debug-access grant — `flagship/debug-access/v1`.
 *
 * Enabling the box's debug console user / SSH is NOT a builder checkbox: it
 * requires an owner-IRK-signed grant that the BOX verifies before turning
 * anything on. The phone signs this grant (behind Face ID) when the user
 * approves the builder's "Debug mode" toggle over the live pairing session;
 * the builder embeds it (+ the authorized SSH key) into the install config;
 * the daemon/bootstrap enables debug access ONLY if the grant verifies
 * against the config-pinned owner IRK. No valid grant ⇒ a production image.
 *
 * This makes the consent load-bearing crypto, not a cosmetic ack — and puts
 * the otherwise-unconditional `debug` user onto an owner-authorized footing.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

export interface DebugAccessGrant {
  /** The box this grant authorizes (its FQDN). */
  serverDomain: string;
  /** OpenSSH authorized public key to install for the debug user; "" = none. */
  sshAuthorizedKey: string;
  issuedAt: number;
}

const TAG_DEBUG_ACCESS = "flagship/debug-access/v1";

export function canonicalDebugAccessGrant(g: DebugAccessGrant): Bytes {
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("sshAuthorizedKey", g.sshAuthorizedKey);
  return new TextEncoder().encode(
    [TAG_DEBUG_ACCESS, g.serverDomain, g.sshAuthorizedKey, String(g.issuedAt)].join("|"),
  );
}

export function signDebugAccessGrant(g: DebugAccessGrant, irk: Keypair): Bytes {
  return ed.sign(canonicalDebugAccessGrant(g), irk.privateKey);
}

/** Verify under the owner IRK. Never throws (hardened ed.verify + try/catch). */
export function verifyDebugAccessGrant(g: DebugAccessGrant, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalDebugAccessGrant(g), irkPub);
  } catch {
    return false;
  }
}
