/**
 * Dev→prod promotion gate (feat/dev-prod-dataspace, spec §5–6).
 *
 * Pure decision core the promote consumer calls before it creates a prod data
 * principal. It answers ONE question: may `(creator, slug)` on this box move
 * from the dev dataspace to production for this exact artifact digest?
 *
 * Two independent authorities must BOTH be satisfied:
 *   1. OWNER/ADMIN authorization — the `ServicePromoteOrder` verifies under the
 *      box's configured authority (owner IRK, or the admin master root when the
 *      account is admin-pinned — same rule as every other sensitive order via
 *      `authorizeSensitiveOrder`).
 *   2. REVIEW authority — a `CodeSecurityAttestation` for the SAME digest,
 *      `verdict:"pass"`, unexpired, verifies under the box's PINNED review key.
 *
 * The author has no path to either signature. If EITHER check fails, the prod
 * principal is not created and the service stays on dev. Fail-closed.
 */
import {
  verifyServicePromote,
  verifyCodeSecurityAttestation,
  type ServicePromoteOrder,
  type CodeSecurityAttestation,
  type Bytes,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";

/** Per-service promotion lifecycle. Prod principals exist only in the last state. */
export type ServiceSpaceState =
  | "authoring"
  | "dev-deployed"
  | "promotion-requested"
  | "prod-deployed";

/** Legal forward transitions. Any other transition is rejected. */
const TRANSITIONS: Record<ServiceSpaceState, ServiceSpaceState[]> = {
  authoring: ["dev-deployed"],
  "dev-deployed": ["promotion-requested"],
  "promotion-requested": ["prod-deployed", "dev-deployed"], // gate pass → prod; gate fail → back to dev
  "prod-deployed": ["dev-deployed"], // a re-edit drops back to dev for re-review
};

export function canTransition(from: ServiceSpaceState, to: ServiceSpaceState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface PromoteGateInput {
  order: ServicePromoteOrder;
  orderSig: Bytes;
  attestation?: CodeSecurityAttestation;
  attestationSig?: Bytes;
  /** Box authority: owner IRK always; admin root when the account is admin-pinned. */
  ownerIrkPub: Bytes;
  adminRootPub?: Bytes;
  username: string;
  /** The box's PINNED review-authority public key. Absent ⇒ gate is closed. */
  reviewAuthorityPub?: Bytes;
  /** Current time (ms). Injected for determinism/tests. */
  now: number;
}

export interface PromoteGateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether promotion to prod is authorized. Returns `{ok:true}` only when
 * BOTH authorities are satisfied for the exact artifact digest. Never throws.
 */
export function evaluatePromoteGate(input: PromoteGateInput): PromoteGateResult {
  // 1. Owner/admin authorization over the promote order.
  const authorized = authorizeSensitiveOrder({
    order: input.order,
    signature: input.orderSig,
    verify: verifyServicePromote,
    ownerIrkPub: input.ownerIrkPub,
    ...(input.adminRootPub ? { adminRootPub: input.adminRootPub } : {}),
    username: input.username,
    now: input.now,
  });
  if (!authorized) return { ok: false, reason: "promote order not authorized (owner/admin signature)" };

  // 2. Review attestation gate.
  if (!input.reviewAuthorityPub || input.reviewAuthorityPub.length !== 32) {
    return { ok: false, reason: "no pinned review authority; promotion refused (fail-closed)" };
  }
  if (!input.attestation || !input.attestationSig) {
    return { ok: false, reason: "no security attestation presented" };
  }
  const a = input.attestation;
  // The attestation MUST bind the same service + exact artifact digest.
  if (
    a.serverId !== input.order.serverId ||
    a.creator !== input.order.creator ||
    a.slug !== input.order.slug ||
    a.artifactDigest !== input.order.artifactDigest
  ) {
    return { ok: false, reason: "attestation does not match the promote order's artifact" };
  }
  if (a.verdict !== "pass") return { ok: false, reason: `attestation verdict is ${a.verdict}` };
  if (a.expiresAt <= input.now) return { ok: false, reason: "attestation expired" };
  if (a.issuedAt > input.now) return { ok: false, reason: "attestation not yet valid" };
  if (!verifyCodeSecurityAttestation(a, input.attestationSig, input.reviewAuthorityPub)) {
    return { ok: false, reason: "attestation signature failed verification" };
  }
  return { ok: true };
}
