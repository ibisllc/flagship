/**
 * Who may open a rescue session (docs/data-sovereignty.md): the box's pinned
 * authority and nothing from `.com`.
 *
 *   - no admin root pinned: the account's IRK (as for every sensitive order);
 *   - an admin root pinned: the admin root itself (the account's original
 *     key, which every admin that was handed the root also holds, so it can't
 *     tell them apart), or an admin DEVICE signing with its own key under a
 *     root-signed grant in the box's verified, locally revoked device book.
 *     The membership IRK is never enough on a pinned box.
 *
 * The signer then passes the same post-quantum gate as every sensitive order
 * (pqAuthority.ts): a rescue order carries no hybrid signature yet, so while
 * the installation's strict profile is in force no rescue session opens.
 */
import { requireMasterAdmin, verifyRescueSession, type AdminGrantView, type RescueExchange } from "@flagship/protocol";
import { gateSigner, pqAuthority, type PqAuthorityContext } from "../pqAuthority.js";
import { trustedNow } from "../trustedClock.js";
import type { RescueSigner } from "./rescue.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function buildRescueAuthorize(a: {
  irkPub: () => Uint8Array;
  adminRootPub: () => Uint8Array | undefined;
  username: string;
  adminGrants: () => readonly AdminGrantView[];
  now?: () => number;
  /** The PQ policy and bindings; defaults to the box's (pqAuthority.ts). */
  pq?: PqAuthorityContext | null;
}): (order: RescueExchange, signature: Uint8Array) => RescueSigner | null {
  const pqOk = (signerHex: string) => gateSigner(a.pq === undefined ? pqAuthority() : a.pq, signerHex, undefined) === null;
  return (order, signature) => {
    const root = a.adminRootPub();
    if (!root || root.length !== 32) {
      const irk = a.irkPub();
      return verifyRescueSession(order, signature, irk) && pqOk(hex(irk)) ? { kind: "root" } : null;
    }
    if (verifyRescueSession(order, signature, root)) return pqOk(hex(root)) ? { kind: "root" } : null;
    const now = a.now?.() ?? trustedNow();
    for (const g of a.adminGrants()) {
      if (g.revokedAt != null) continue;
      if (!verifyRescueSession(order, signature, g.grant.devicePubKey)) continue;
      if (!requireMasterAdmin(hex(g.grant.devicePubKey), a.username, hex(root), [g], now).ok) continue;
      if (!pqOk(hex(g.grant.devicePubKey))) return null;
      return { kind: "device", grantId: g.grant.grantId, deviceId: g.grant.deviceId, grantIssuedAt: g.grant.issuedAt };
    }
    return null;
  };
}
