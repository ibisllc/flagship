/**
 * Quantum-safe stage 1 (docs/architecture-v2/pq-suites.md §20): the two places where a classical
 * signature by an account root still created authority that the strict gate then trusted.
 *
 *   - **Admin-root rotation.** A v1 rotation (`flagship/admin-root-rotation/v1`) is signed by the
 *     old root's Ed25519 key only, and the new root's ML-DSA key was taken first-come from `.com`.
 *     The companion here is the old root's HYBRID signature over the same fields plus the hybrid
 *     key id of the new root's own `admin-root` binding, so under strict a box re-pins only to a
 *     root (and an ML-DSA key) the old root's PQ half named.
 *   - **Device capability grants.** A grant (`flagship/device-capability-grant/v2`) is signed by
 *     the admin root or the IRK with Ed25519; a forged grant would admit an attacker's device,
 *     whose own binding then passes the gate. The companion is the signing root's hybrid signature
 *     over the grant's canonical bytes; under strict a box admits a device only with it.
 *
 * Both run through `verifyCriticalSignature` with the signer's verified binding and are refused
 * unless their suite is the hybrid one (a classical "companion" adds nothing).
 */
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import { canonicalDeviceCapabilityGrant, type DeviceCapabilityGrant } from "./deviceCapability.js";
import type { AdminRootRotation } from "./adminRootRotation.js";
import type { PolicyState } from "./assurancePolicy.js";
import { SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, hybridSign, pqKeyId } from "./pqHybrid.js";
import {
  PqTrustError,
  pqBindingPublicKey,
  pqKeyBindingFromWire,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PqKeyBindingWire,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "./pqTrust.js";
import type { Bytes } from "./types.js";

export const TAG_ADMIN_ROOT_ROTATION_V2 = "flagship/admin-root-rotation/v2";
export const TAG_DEVICE_CAPABILITY_GRANT = "flagship/device-capability-grant/v2";
const HYBRID = "hybrid-ed25519-mldsa65/v1";
const KEY_ID = /^[0-9a-f]{64}$/;

/** What travels beside a v1 rotation: the old root's hybrid signature and the new root's binding. */
export interface AdminRootRotationPq {
  signature: SignatureEnvelope;
  newRootBinding: PqKeyBindingWire;
}

/** The hybrid key id of a binding's two keys (no signature check). */
export function pqBindingKeyIdHex(w: Pick<PqKeyBindingWire, "ed25519PubHex" | "mldsaPubHex">): string {
  return hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey(w)));
}

/**
 * `flagship/admin-root-rotation/v2|<username>|<oldRootHex>|<newRootHex>|<issuedAt>|<newRootKeyIdHex>`:
 * the v1 fields, then the key id of the new root's `admin-root` binding.
 */
export function canonicalAdminRootRotationV2(r: AdminRootRotation, newRootKeyIdHex: string): Bytes {
  legacyFieldGuard("username", r.username);
  if (!KEY_ID.test(newRootKeyIdHex)) throw new Error("newRootKeyIdHex must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) throw new Error("issuedAt must be a non-negative integer");
  return new TextEncoder().encode(
    [TAG_ADMIN_ROOT_ROTATION_V2, r.username, hex(r.oldAdminRootPub), hex(r.newAdminRootPub), r.issuedAt, newRootKeyIdHex].join("|"),
  );
}

/** Signs the companion with the old root's hybrid secret (Ed25519 seed || ML-DSA seed). */
export function signAdminRootRotationPq(
  r: AdminRootRotation,
  oldRootHybridSecret: Bytes,
  newRootBinding: PqKeyBindingWire,
  opts: { deterministic?: boolean } = {},
): AdminRootRotationPq {
  const msg = canonicalAdminRootRotationV2(r, pqBindingKeyIdHex(newRootBinding));
  const sig = hybridSign(oldRootHybridSecret, TAG_ADMIN_ROOT_ROTATION_V2, msg, opts);
  return { signature: { suite: HYBRID, signature: hex(sig) }, newRootBinding };
}

function envelopeOf(raw: unknown): SignatureEnvelope {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.suite !== "string" || typeof o.signature !== "string") throw new PqTrustError("bad-signature");
  if (o.suite !== HYBRID) throw new PqTrustError(o.suite === "ed25519/v1" ? "strict-requires-hybrid" : "unknown-suite");
  return { suite: HYBRID, signature: o.signature };
}

/**
 * Verifies a rotation's companion and returns the new root's verified binding (the ML-DSA key the
 * old root named). `oldRootBinding` is the verifier's own pin for the old root, never `.com`'s
 * word. Throws `PqTrustError`.
 */
export function verifyAdminRootRotationPq(args: {
  rotation: AdminRootRotation;
  pq: unknown;
  oldRootBinding: VerifiedPqKeyBinding | null;
  policy: PolicyState;
  now: number;
}): VerifiedPqKeyBinding {
  const o = args.pq && typeof args.pq === "object" ? (args.pq as Record<string, unknown>) : null;
  if (!o) throw new PqTrustError("strict-requires-hybrid");
  const envelope = envelopeOf(o.signature);
  const wire = pqKeyBindingFromWire(o.newRootBinding);
  const newBinding = verifyPqKeyBinding(wire, {
    role: "admin-root",
    subjectId: args.rotation.username.toLowerCase(),
    ed25519PubHex: hex(args.rotation.newAdminRootPub),
    now: args.now,
  });
  verifyCriticalSignature({
    message: canonicalAdminRootRotationV2(args.rotation, newBinding.keyIdHex),
    expectedPurpose: TAG_ADMIN_ROOT_ROTATION_V2,
    envelope,
    signerEd25519PubHex: hex(args.rotation.oldAdminRootPub),
    binding: args.oldRootBinding,
    policy: args.policy,
  });
  return newBinding;
}

/** Signs a grant's companion with the signing root's hybrid secret. */
export function signDeviceGrantPq(
  g: DeviceCapabilityGrant,
  rootHybridSecret: Bytes,
  opts: { deterministic?: boolean } = {},
): SignatureEnvelope {
  return { suite: HYBRID, signature: hex(hybridSign(rootHybridSecret, TAG_DEVICE_CAPABILITY_GRANT, canonicalDeviceCapabilityGrant(g), opts)) };
}

/**
 * Verifies a grant's companion: the hybrid signature of `signerPubHex` (the root the grant's
 * classical signature verified under) by that root's verified binding. Throws `PqTrustError`.
 */
export function verifyDeviceGrantPq(args: {
  grant: DeviceCapabilityGrant;
  pq: unknown;
  signerPubHex: string;
  signerBinding: VerifiedPqKeyBinding | null;
  policy: PolicyState;
}): void {
  const envelope = envelopeOf(args.pq);
  let message: Bytes;
  try {
    message = canonicalDeviceCapabilityGrant(args.grant);
  } catch {
    throw new PqTrustError("bad-signature");
  }
  verifyCriticalSignature({
    message,
    expectedPurpose: TAG_DEVICE_CAPABILITY_GRANT,
    envelope,
    signerEd25519PubHex: args.signerPubHex,
    binding: args.signerBinding,
    policy: args.policy,
  });
}
