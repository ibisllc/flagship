/**
 * Slice D — the shared master-admin authority predicate
 * (docs/device-admin-tier-spec.md §3).
 *
 * ONE predicate BOTH runtimes call — `.com` (`@flagship/control-plane`) and the
 * box daemon (`@flagship/server-daemon`) — rooted in the account's ADMIN MASTER
 * ROOT, NOT the membership IRK. It lives in `@flagship/protocol` (which both
 * already import) and is PURE: it takes the pinned admin-root pubkey + the set
 * of the account's active grants and returns a decision, with no storage or
 * network dependency. Each runtime adapts its own grant rows into the
 * {@link AdminGrantView} shape and passes them in.
 *
 * Authority model:
 *   satisfied  ⟺  signer IS the bare admin master root
 *              OR  signer holds a VALID, non-revoked, non-expired, `admin`-scope
 *                  DeviceCapabilityGrant that is `admin-root`-signed and whose
 *                  Ed25519 signature verifies UNDER the admin master root.
 *
 * The membership IRK (UMK-derived, held by every device) can NEVER satisfy this
 * — that is the whole point of the split. The companion fence in
 * `requireDeviceScope` (control-plane) stops the legacy `signer == IRK` fast
 * path from ever satisfying a SENSITIVE scope; here, a `'membership'`-signed
 * grant is rejected outright for the admin scope.
 */
import {
  verifyDeviceCapabilityGrant,
  type AdminSignerRoot,
  type DeviceCapabilityGrant,
} from "./deviceCapability.js";

// Note: `SENSITIVE_SCOPES`, `isSensitiveScope`, and `AdminSignerRoot` are the
// authority contract and are already exported from `@flagship/protocol` (via
// `deviceCapability.ts`). We import them here rather than re-export, to avoid a
// duplicate `export *` name collision at the package barrel.

/**
 * A runtime-agnostic view of ONE active device grant, adapted from whatever the
 * caller's storage row looks like. `.com` builds these from
 * `DeviceCapabilityGrantRecord`; the box builds them from its refreshed
 * `/api/users/:u/device-grants` snapshot.
 */
export interface AdminGrantView {
  /** The reconstructed, canonicalizable grant envelope. */
  grant: DeviceCapabilityGrant;
  /** Ed25519 signature over the grant's canonical bytes, hex. */
  signatureHex: string;
  /** Which root signed the grant (§3.3). Only `'admin-root'` carries authority. */
  signerRoot: AdminSignerRoot;
  /** Revocation tombstone (ms) or null/undefined when active. */
  revokedAt?: number | null;
}

export type MasterAdminDecision = { ok: true } | { ok: false; reason: string };

function normHex(h: string): string {
  return h.trim().toLowerCase();
}

function hexToBytes(h: string): Uint8Array {
  const s = h.length % 2 === 1 ? `0${h}` : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex");
    out[i] = byte;
  }
  return out;
}

/**
 * Is `signerPubHex` a master admin for `username`?
 *
 * @param signerPubHex     the pubkey that signed the order, hex.
 * @param username         the account under which authority is asserted.
 * @param adminRootPubHex  the account's pinned admin master-root pubkey, hex
 *                         (undefined ⇒ no admin anchor ⇒ deny).
 * @param activeGrants     the account's ACTIVE device grants (the caller may
 *                         pre-filter to active; revoked/expired are re-checked
 *                         here defensively regardless).
 * @param now             ms clock (defaults to Date.now()); used for expiry.
 *
 * Satisfied iff the signer is the bare admin root, OR holds a valid
 * non-revoked, non-expired, admin-root-signed `admin` grant that verifies under
 * the admin root. The membership IRK is NEVER a master admin here.
 */
export function requireMasterAdmin(
  signerPubHex: string,
  username: string,
  adminRootPubHex: string | undefined,
  activeGrants: readonly AdminGrantView[],
  now: number = Date.now(),
): MasterAdminDecision {
  if (!adminRootPubHex) return { ok: false, reason: "no admin root" };
  const adminRoot = normHex(adminRootPubHex);
  const signer = normHex(signerPubHex);
  const userNorm = username.toLowerCase();

  // 1. The bare admin master root signs directly.
  if (signer === adminRoot) return { ok: true };

  // 2. A device holding an admin-root-signed `admin` grant for this device key.
  const view = activeGrants.find(
    (g) => normHex(bytesToHexLocal(g.grant.devicePubKey)) === signer,
  );
  if (!view) return { ok: false, reason: "no active admin grant" };
  if (view.revokedAt != null) return { ok: false, reason: "no active admin grant" };
  if (view.grant.username.toLowerCase() !== userNorm) {
    return { ok: false, reason: "username mismatch" };
  }
  if (now >= view.grant.expiresAt) return { ok: false, reason: "grant expired" };
  // The signer discriminator: a membership-IRK-signed grant is NOT admin
  // authority even if it lists the `admin` scope (a UMK holder must not be
  // able to forge admin). Only an admin-root-signed grant is trusted here.
  if (view.signerRoot !== "admin-root") {
    return { ok: false, reason: "grant not admin-root-signed" };
  }
  if (!view.grant.scopes.includes("admin")) {
    return { ok: false, reason: "missing admin scope" };
  }
  // Cryptographic proof: the grant must verify UNDER THE ADMIN ROOT (not the
  // membership IRK). This is what makes a `.com`-relayed admin grant trustable.
  let adminRootBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    adminRootBytes = hexToBytes(adminRoot);
    sig = hexToBytes(normHex(view.signatureHex));
  } catch {
    return { ok: false, reason: "invalid hex" };
  }
  if (!verifyDeviceCapabilityGrant(view.grant, sig, adminRootBytes)) {
    return { ok: false, reason: "grant signature failed verification" };
  }
  return { ok: true };
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
