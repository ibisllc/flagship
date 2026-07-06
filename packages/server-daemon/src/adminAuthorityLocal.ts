import { requireMasterAdmin, type AdminGrantView } from "@flagship/protocol";

/**
 * Slice D — box-local sensitive-order authorization gate
 * (docs/device-admin-tier-spec.md §3.1).
 *
 * ONE shared predicate every re-pointed box-side SENSITIVE op routes through, so
 * the gated transition is identical everywhere. It wraps the pure
 * `requireMasterAdmin` predicate from `@flagship/protocol` with the box's local
 * signature-verification: the deposited carrier holds only the order + a bare
 * signature (no explicit signer pubkey), so we RESOLVE the signer by trying the
 * candidate authority keys and confirming the order signature verifies under one.
 *
 * GATED TRANSITION (the critical no-op requirement):
 *   - `adminRootPub` ABSENT (every pre-wipe box today) ⇒ fall back to the EXISTING
 *     owner-IRK verification UNCHANGED. The admin tier is a strict no-op until a
 *     box is reburned with a pinned admin root.
 *   - `adminRootPub` PRESENT ⇒ the order is authorized ONLY when it is signed by
 *     the bare admin master root (the box-side owner-admin-device path — pass
 *     `activeGrants: []`) OR by a device holding an admin-root-signed `admin`
 *     grant that `requireMasterAdmin` accepts. An owner-IRK-signed order is
 *     REJECTED (the membership IRK is never a master admin).
 *
 * Box-side today the owner's admin device signs sensitive box orders with the
 * BARE admin root, so callers pass `activeGrants: []` (the `signer === adminRoot`
 * path). The delegated-admin-box-side path (a box-local device-grants snapshot,
 * refreshed from `.com` `/api/users/:u/device-grants`) is structurally supported
 * here — pass `activeGrants` when such a snapshot is wired — but is a Phase
 * follow-up; no box-local grant refresh feeds it yet.
 */
export interface AuthorizeSensitiveOrderArgs<TOrder> {
  /** The parsed order/envelope whose signature is being authorized. */
  order: TOrder;
  /** Ed25519 signature over the order's canonical bytes. */
  signature: Uint8Array;
  /**
   * The order-type-specific verifier (`verifyServersSelfDelete`,
   * `verifyPhoneOrder`, `verifyRootEntitlement`, …). Every sensitive verifier in
   * the daemon has the `(order, sig, pub) => boolean` shape.
   */
  verify: (order: TOrder, sig: Uint8Array, pub: Uint8Array) => boolean;
  /** The config-pinned MEMBERSHIP owner IRK — the LEGACY (fallback) anchor. */
  ownerIrkPub: Uint8Array;
  /**
   * The config-pinned ADMIN MASTER ROOT (`ServerConfig.adminRootPub`). Absent ⇒
   * legacy owner-IRK path (the gate is a no-op).
   */
  adminRootPub?: Uint8Array;
  /** The account name (for the delegated-grant username check). */
  username: string;
  /**
   * The account's ACTIVE admin device grants (box-local snapshot). Box-side today
   * this is `[]` (bare-admin-root only); a future box-local grant refresh feeds
   * the delegated path.
   */
  activeGrants?: readonly AdminGrantView[];
  /** ms clock (defaults to Date.now()); used for grant expiry. */
  now?: number;
}

/**
 * Authorize a SENSITIVE box order under the Slice D master-admin authority, with
 * the clean-slate transition gate. Returns true iff the order is authorized.
 */
export function authorizeSensitiveOrder<TOrder>(
  args: AuthorizeSensitiveOrderArgs<TOrder>,
): boolean {
  // Transition gate: no pinned admin anchor ⇒ legacy owner-IRK verification,
  // byte-for-byte unchanged. (A malformed/short value is treated as absent —
  // config.ts already drops a malformed adminRootPub, this is belt-and-braces.)
  if (!args.adminRootPub || args.adminRootPub.length !== 32) {
    return args.verify(args.order, args.signature, args.ownerIrkPub);
  }

  const adminRootHex = bytesToHex(args.adminRootPub);
  const grants = args.activeGrants ?? [];

  // 1. The bare admin master root signs directly (the box-side owner-admin path).
  if (args.verify(args.order, args.signature, args.adminRootPub)) {
    return requireMasterAdmin(adminRootHex, args.username, adminRootHex, grants, args.now).ok;
  }

  // 2. A delegated admin device: the order is signed by a device key that holds a
  //    valid admin-root-signed `admin` grant. (No-op today box-side: `grants` is
  //    empty until a box-local grants refresh is wired — Phase follow-up.)
  for (const g of grants) {
    const devicePub = g.grant.devicePubKey;
    if (devicePub.length !== 32) continue;
    if (!args.verify(args.order, args.signature, devicePub)) continue;
    if (requireMasterAdmin(bytesToHex(devicePub), args.username, adminRootHex, grants, args.now).ok) {
      return true;
    }
  }

  return false;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
