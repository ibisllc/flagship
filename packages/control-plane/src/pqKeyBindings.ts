import {
  PqTrustError,
  legacyPolicyState,
  pqKeyBindingFromWire,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PolicyState,
  type PqKeyBindingWire,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import type { PolicyStateRecord, PqKeyBindingRecord, PqTrustStorage, ServerStorage } from "@flagship/storage";
import { forbidden, malformed, notFound, type HandlerResponse } from "./types.js";

/**
 * Architecture v2 milestone 1: a box's STK hybrid key binding (packages/protocol/src/pqTrust.ts)
 * and the critical-signature gate as `.com` runs it.
 *
 * `PUT /api/server/:host/pq-key-binding`   body = the box-stk binding, both keys' proof
 * `GET /api/server/:host/pq-key-binding`   public: the binding, for clients to verify under
 *                                          the STK they pinned (and to pin the ML-DSA key)
 *
 * `.com` stores a binding only when it verifies under the server's registered STK, keeps the
 * first ML-DSA key per STK, and serves one only while the STK is still the registered one. It is
 * a relay, not a trust root: every client verifies against its own pin.
 */
export interface PqKeyBindingDeps {
  servers: ServerStorage;
  pqTrust: PqTrustStorage;
  now?: () => number;
}

const ROLE = "box-stk";

function wireOf(rec: PqKeyBindingRecord): PqKeyBindingWire {
  return {
    v: 1,
    role: rec.role as PqKeyBindingWire["role"],
    subjectId: rec.subjectId,
    ed25519PubHex: rec.ed25519PubHex,
    mldsaPubHex: rec.mldsaPubHex,
    issuedAt: rec.issuedAt,
    signature: rec.signatureHex,
  };
}

// Verifying ML-DSA costs a few ms of Worker CPU; a stored binding is the same bytes on every
// heartbeat, so an isolate remembers what it verified (keyed by every byte that was checked).
const cache = new Map<string, VerifiedPqKeyBinding>();
const CACHE_MAX = 512;

/** A stored box-stk binding, verified under the server's current STK; null when it is not. */
export function verifiedStoredStkBinding(rec: PqKeyBindingRecord | null, serverDomain: string, stkPubHex: string, now: number): VerifiedPqKeyBinding | null {
  if (!rec) return null;
  const domain = serverDomain.toLowerCase();
  const stk = stkPubHex.toLowerCase();
  if (rec.role !== ROLE || rec.subjectId !== domain || rec.ed25519PubHex !== stk) return null;
  const key = `${domain}|${stk}|${rec.mldsaPubHex}|${rec.issuedAt}|${rec.signatureHex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const b = verifyPqKeyBinding(wireOf(rec), { role: ROLE, subjectId: domain, ed25519PubHex: stk, now: Math.max(now, rec.issuedAt) });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, b);
    return b;
  } catch {
    return null;
  }
}

const PROFILES = new Set(["strict", "compatibility"]);
const ROLLOUTS = new Set(["legacy", "capable", "prepared", "enforced", "retired"]);

/**
 * The installation scope's PolicyState. No row is legacy (classical accepted); a row this code
 * cannot read is treated as strict and enforced, so a corrupt or newer row never weakens a scope.
 */
export function installationPolicy(rec: PolicyStateRecord | null, serverDomain: string): PolicyState {
  const scope = { kind: "installation" as const, id: serverDomain.toLowerCase() };
  if (!rec) return legacyPolicyState(scope);
  if (!PROFILES.has(rec.profile) || !ROLLOUTS.has(rec.rollout)) {
    return { scope, profile: "strict", rollout: "enforced", generation: rec.generation, headDigest: rec.headDigest, enforcedEver: true };
  }
  return {
    scope,
    profile: rec.profile as PolicyState["profile"],
    rollout: rec.rollout as PolicyState["rollout"],
    generation: rec.generation,
    headDigest: rec.headDigest,
    enforcedEver: rec.enforcedEver,
  };
}

export async function handlePutPqKeyBinding(deps: PqKeyBindingDeps, host: string, body: unknown): Promise<HandlerResponse> {
  const now = (deps.now ?? (() => Date.now()))();
  const domain = host.toLowerCase();
  let wire: PqKeyBindingWire;
  try {
    wire = pqKeyBindingFromWire(body);
  } catch (e) {
    return malformed(e instanceof PqTrustError ? e.code : "malformed body");
  }
  if (wire.role !== ROLE) return forbidden("only a box-stk binding is accepted here");
  if (wire.subjectId !== domain) return forbidden("subjectId / host mismatch");
  const reg = await deps.servers.get(domain);
  if (!reg) return notFound("unknown server");
  if (reg.revokedAt) return forbidden("server is revoked");
  try {
    verifyPqKeyBinding(wire, { role: ROLE, subjectId: domain, ed25519PubHex: reg.identityPubKeyHex, now });
  } catch (e) {
    return forbidden(e instanceof PqTrustError ? e.code : "the binding does not verify");
  }
  const put = await deps.pqTrust.putBinding({
    role: ROLE,
    subjectId: domain,
    ed25519PubHex: wire.ed25519PubHex,
    mldsaPubHex: wire.mldsaPubHex,
    issuedAt: wire.issuedAt,
    signatureHex: wire.signature,
    storedAt: now,
  });
  if (!put.ok) return { status: 409, body: { error: put.reason } };
  return { status: 200, body: { ok: true } };
}

export async function handleGetPqKeyBinding(deps: PqKeyBindingDeps, host: string): Promise<HandlerResponse> {
  const domain = host.toLowerCase();
  const reg = await deps.servers.get(domain);
  if (!reg || reg.revokedAt) return notFound("no binding on file");
  const rec = await deps.pqTrust.getBinding(ROLE, domain);
  if (!rec || !verifiedStoredStkBinding(rec, domain, reg.identityPubKeyHex, (deps.now ?? Date.now)())) return notFound("no binding on file");
  return { status: 200, body: wireOf(rec) };
}

/**
 * Runs a box-signed critical message through the gate. `pqSignature` is the hybrid envelope the
 * box sent beside its classical signature (absent from a box without keyd's hybrid key). When
 * the box sent one it must verify; when the scope is strict, the hybrid one is required.
 * Returns null when accepted, else the refusal code.
 */
export function gateBoxMessage(args: {
  message: Uint8Array;
  purpose: string;
  classicalSignatureHex: string;
  pqSignature: unknown;
  stkPubHex: string;
  binding: VerifiedPqKeyBinding | null;
  policy: PolicyState;
}): string | null {
  const envelope: SignatureEnvelope =
    args.pqSignature === undefined
      ? { suite: "ed25519/v1", signature: args.classicalSignatureHex.toLowerCase() }
      : ((typeof args.pqSignature === "object" && args.pqSignature !== null ? args.pqSignature : {}) as SignatureEnvelope);
  try {
    verifyCriticalSignature({
      message: args.message,
      expectedPurpose: args.purpose,
      envelope,
      signerEd25519PubHex: args.stkPubHex,
      binding: args.binding,
      policy: args.policy,
    });
    return null;
  } catch (e) {
    return e instanceof PqTrustError ? e.code : "bad-signature";
  }
}
