/**
 * The sensitive-order check for the restore-into-server orders (docs/restore-into-server.md §4):
 * the admin root on a pinned box (the IRK on one without), and while the box is strict the
 * signer's hybrid half too. An order the admin signed classically that a strict box refuses reads
 * as `"needs-hybrid"`, so a browser (no ML-DSA key) can point the owner to the phone.
 */
import { authorizeSensitiveOrder } from "../../adminAuthorityLocal.js";
import { hybridOrderSignature, type PqAuthorityContext } from "../../pqAuthority.js";

export interface RestoreOrderAuthority {
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username: string;
  verify: (canonical: Uint8Array, sig: Uint8Array, pub: Uint8Array) => boolean;
  /** Tests only; the box's own policy and bindings otherwise. */
  pq?: PqAuthorityContext | null;
}

export function authorizeRestoreOrder(a: RestoreOrderAuthority, canonical: Uint8Array, signature: Uint8Array, pqSignature: unknown): boolean | "needs-hybrid" {
  const base = {
    ownerIrkPub: a.ownerIrkPub,
    ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
    username: a.username,
    order: canonical,
    signature,
    verify: a.verify,
  };
  const hybrid = hybridOrderSignature(canonical, pqSignature);
  if (authorizeSensitiveOrder({ ...base, ...(a.pq !== undefined ? { pq: a.pq } : {}), ...(hybrid ? { hybrid } : {}) })) return true;
  return authorizeSensitiveOrder({ ...base, pq: null }) ? "needs-hybrid" : false;
}
