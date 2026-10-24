/**
 * Architecture v2 milestone 2 (docs/architecture-v2/pq-suites.md §11): what the box's critical
 * verifiers need to apply the owner's assurance policy. The installation's PolicyState comes
 * from the owner-signed chain the box replays itself (assurancePolicySync.ts); bindings come
 * from the device book. While strict is in force, `authorizeSensitiveOrder` refuses an order
 * that carries no hybrid signature by a bound key, whatever its classical signature says.
 */
import {
  PqTrustError,
  messagePurpose,
  strictInForce,
  verifyCriticalSignature,
  type PolicyState,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";

export interface PqAuthorityContext {
  /** The installation scope's policy in force on this box. */
  policy(): PolicyState;
  /** The verified ML-DSA binding of a key this box trusts, or null. */
  bindingFor(pubHex: string): VerifiedPqKeyBinding | null;
}

/** An order's hybrid signature as a client sends it beside the classical one. */
export interface HybridOrderSignature {
  /** The order's canonical v1 bytes (`<purpose>|...`). */
  message: Uint8Array;
  envelope: SignatureEnvelope;
}

let current: PqAuthorityContext | null = null;

/** Wired once at boot; tests set and clear it. */
export function setPqAuthority(ctx: PqAuthorityContext | null): void {
  current = ctx;
}

export function pqAuthority(): PqAuthorityContext | null {
  return current;
}

/**
 * The gate for a signer the classical check already identified. Outside strict it accepts (the
 * classical check stands); a hybrid signature that is sent must still verify. Under strict a
 * hybrid signature by the signer's bound key is required. Returns null when accepted, else the
 * refusal code.
 */
export function gateSigner(ctx: PqAuthorityContext | null, signerPubHex: string, hybrid: HybridOrderSignature | undefined): string | null {
  if (!ctx) return null;
  const policy = ctx.policy();
  // The classical signature was already checked by the caller; without a hybrid one the only
  // question left is whether this scope still accepts classical-only orders.
  if (!hybrid) return strictInForce(policy) ? "strict-requires-hybrid" : null;
  try {
    verifyCriticalSignature({
      message: hybrid.message,
      expectedPurpose: messagePurpose(hybrid.message),
      envelope: hybrid.envelope,
      signerEd25519PubHex: signerPubHex,
      binding: ctx.bindingFor(signerPubHex),
      policy,
    });
    return null;
  } catch (e) {
    return e instanceof PqTrustError ? e.code : "bad-signature";
  }
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * The hybrid signature a client sends beside an order's classical one (`pqSignature: { suite,
 * signature }` next to `signature`), bound to that order's canonical bytes. A field that is
 * present but not this shape becomes an envelope the gate refuses, so a broken PQ half never
 * reads as "no PQ half".
 */
export function hybridOrderSignature(canonical: Uint8Array, raw: unknown): HybridOrderSignature | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as { suite?: unknown; signature?: unknown };
  const suite = o && typeof o === "object" && typeof o.suite === "string" ? o.suite : "unknown";
  const signature = o && typeof o === "object" && typeof o.signature === "string" && HEX.test(o.signature) ? o.signature : "zz";
  return { message: canonical, envelope: { suite: suite as SignatureEnvelope["suite"], signature } };
}
