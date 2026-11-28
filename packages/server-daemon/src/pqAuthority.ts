/**
 * Architecture v2 milestone 2 (docs/architecture-v2/pq-suites.md §11): what the box's critical
 * verifiers need to apply the owner's assurance policy. The installation's PolicyState comes
 * from the owner-signed chain the box replays itself (assurancePolicySync.ts); bindings come
 * from the device book. While strict is in force, `authorizeSensitiveOrder` refuses an order
 * that carries no hybrid signature by a bound key, whatever its classical signature says.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
 * How the request that carries an order reached the box, when that path itself is quantum-safe
 * or is one of the owner's labelled classical exceptions (pq-suites.md §21.1):
 *
 *   device   over the PQ channel (`pqChannel.ts`), whose handshake a device of the account signed
 *            hybrid under its bound key. `actsFor` lists the keys whose classical orders that
 *            device may carry: its own key, the account key it holds, and the admin root when the
 *            device book holds it as an admin device.
 *   sibling  over the PQ channel from a server the account's hybrid-signed order vouches for, or
 *            entries such a server relayed (access sync). Each entry was admitted once by the box
 *            that took it from the owner, under the same rules.
 *   browser  a live paired browser session while the owner's strict change allowed browsers
 *            (`browser-without-pq-authentication`): the labelled classical path.
 *
 * A request that came any other way (a `.com` deposit, a box poll) carries no authority, and
 * under strict its order needs its own hybrid signature.
 */
export type TransportAuthority =
  | { kind: "device"; actsFor: ReadonlySet<string> }
  | { kind: "sibling" }
  | { kind: "browser" };

const transport = new AsyncLocalStorage<TransportAuthority | null>();

export function withTransportAuthority<T>(a: TransportAuthority | null, fn: () => T): T {
  return transport.run(a, fn);
}

export function currentTransportAuthority(): TransportAuthority | null {
  return transport.getStore() ?? null;
}

function carriedBy(a: TransportAuthority | null, signerPubHex: string): boolean {
  if (!a) return false;
  if (a.kind === "device") return a.actsFor.has(signerPubHex.toLowerCase());
  return true;
}

/**
 * The gate for a signer the classical check already identified. Outside strict it accepts (the
 * classical check stands); a hybrid signature that is sent must still verify. Under strict a
 * hybrid signature by the signer's bound key is required, unless the order came over a path
 * that is itself quantum-safe for that signer, or the owner's browser exception
 * (`TransportAuthority`). Returns null when accepted, else the refusal code.
 */
export function gateSigner(ctx: PqAuthorityContext | null, signerPubHex: string, hybrid: HybridOrderSignature | undefined): string | null {
  if (!ctx) return null;
  const policy = ctx.policy();
  // The classical signature was already checked by the caller; without a hybrid one the only
  // question left is whether this scope still accepts classical-only orders.
  if (!hybrid) return strictInForce(policy) && !carriedBy(currentTransportAuthority(), signerPubHex) ? "strict-requires-hybrid" : null;
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
