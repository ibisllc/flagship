/**
 * Architecture v2 milestone 1: a hybrid key binding for every identity, and the one gate every
 * critical signature goes through. DRAFT, pending Q01 external cryptographic review.
 * Spec: docs/architecture-v2/pq-suites.md §9-§10. Vectors: test-vectors/pq-binding/.
 * Rust twin: rust/crates/flagship-crypto/src/trust.rs.
 *
 * Binding (`flagship/pq-key-binding/v1`): an identity's existing Ed25519 key and its new
 * ML-DSA-65 key sign one statement together, with the hybrid suite
 * `flagship/hybrid-sig/ed25519-mldsa65/v1` under the public key `ed25519 || mldsa65`:
 *
 *   flagship/pq-key-binding/v1|<role>|<subjectId>|<ed25519PubHex>|<mldsa65PubHex>|<issuedAt>
 *
 * Both components sign the same M' (which binds both keys again), so the binding is a mutual
 * proof of possession: neither key can be paired with a key whose holder did not sign.
 *
 * Gate (`verifyCriticalSignature`): while a scope's strict profile is in force, a critical
 * message is accepted only with the hybrid AND-signature over a bound key. Otherwise it accepts
 * the classical Ed25519 signature or the hybrid one. The policy, never the envelope, picks what
 * is required, so stripping the hybrid suite cannot downgrade a strict scope.
 */
import { strictInForce, type PolicyState, type SignatureSuite } from "./assurancePolicy.js";
import {
  HYBRID_SIG_LEN,
  PqHybridError,
  ed25519VerifyStrict,
  hybridVerify,
  parseHybridSigPublicKey,
  pqKeyId,
  SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  validatePurposeTag,
} from "./pqHybrid.js";
import type { Bytes } from "./types.js";

export const TAG_PQ_KEY_BINDING = "flagship/pq-key-binding/v1";
export const PQ_BINDING_ROLES = ["account-irk", "admin-root", "device", "box-stk", "boot-key"] as const;
export type PqBindingRole = (typeof PQ_BINDING_ROLES)[number];
/** How far ahead of the verifier's clock a binding may be dated. */
export const PQ_BINDING_MAX_SKEW_MS = 5 * 60 * 1000;
export const ED25519_SIG_LEN = 64;
const MLDSA65_PK_HEX_LEN = 1952 * 2;

export type PqTrustErrorCode =
  | "binding-malformed"
  | "binding-role"
  | "binding-subject"
  | "binding-key-mismatch"
  | "binding-pq-key-changed"
  | "binding-future"
  | "binding-stale"
  | "bad-public-key"
  | "bad-signature"
  | "bad-purpose"
  | "purpose-mismatch"
  | "unknown-suite"
  | "strict-requires-hybrid"
  | "strict-requires-binding"
  | "no-binding";

/** A refusal; `code` matches the Rust port and the vectors' `expect`. */
export class PqTrustError extends Error {
  readonly code: PqTrustErrorCode;
  constructor(code: PqTrustErrorCode) {
    super(code);
    this.name = "PqTrustError";
    this.code = code;
  }
}

const fail = (code: PqTrustErrorCode): never => {
  throw new PqTrustError(code);
};

const SUBJECT = /^[a-z0-9][a-z0-9._:@-]{0,252}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX_MLDSA = /^[0-9a-f]+$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

export interface PqKeyBindingStatement {
  role: PqBindingRole;
  subjectId: string;
  ed25519PubHex: string;
  mldsaPubHex: string;
  issuedAt: number;
}

export interface PqKeyBindingWire extends PqKeyBindingStatement {
  v: 1;
  /** The hybrid signature (3373 bytes), lowercase hex. */
  signature: string;
}

export function isPqBindingRole(r: unknown): r is PqBindingRole {
  return typeof r === "string" && (PQ_BINDING_ROLES as readonly string[]).includes(r);
}

function checkStatement(s: PqKeyBindingStatement): void {
  if (!isPqBindingRole(s.role)) fail("binding-role");
  if (typeof s.subjectId !== "string" || !SUBJECT.test(s.subjectId)) fail("binding-subject");
  if (typeof s.ed25519PubHex !== "string" || !HEX32.test(s.ed25519PubHex)) fail("binding-malformed");
  if (typeof s.mldsaPubHex !== "string" || s.mldsaPubHex.length !== MLDSA65_PK_HEX_LEN || !HEX_MLDSA.test(s.mldsaPubHex)) fail("binding-malformed");
  if (!Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) fail("binding-malformed");
}

/** The statement both keys sign. */
export function canonicalPqKeyBinding(s: PqKeyBindingStatement): Bytes {
  checkStatement(s);
  return new TextEncoder().encode(
    [TAG_PQ_KEY_BINDING, s.role, s.subjectId, s.ed25519PubHex, s.mldsaPubHex, String(s.issuedAt)].join("|"),
  );
}

/** `ed25519 || mldsa65`, the hybrid suite's public key for this binding. */
export function pqBindingPublicKey(s: Pick<PqKeyBindingStatement, "ed25519PubHex" | "mldsaPubHex">): Bytes {
  return fromHex(s.ed25519PubHex + s.mldsaPubHex);
}

/**
 * Signs a hybrid message whose purpose is its own tag (everything before the first `|`), the
 * shape keyd's `sign.hybrid` takes. Returns the 3373-byte hybrid signature.
 */
export type HybridMsgSigner = (msg: Bytes) => Bytes;

export function signPqKeyBinding(s: PqKeyBindingStatement, signer: HybridMsgSigner): PqKeyBindingWire {
  const sig = signer(canonicalPqKeyBinding(s));
  return { v: 1, ...s, signature: toHex(sig) };
}

const verified = new WeakSet<object>();

/** A binding that verified. Only `verifyPqKeyBinding` makes one; the gate refuses look-alikes. */
export interface VerifiedPqKeyBinding {
  readonly role: PqBindingRole;
  readonly subjectId: string;
  readonly ed25519PubHex: string;
  readonly mldsaPubHex: string;
  readonly issuedAt: number;
  readonly hybridPublicKey: Bytes;
  /** `pqKeyId(0x0002, hybridPublicKey)`, hex. */
  readonly keyIdHex: string;
}

export interface PqBindingExpectation {
  role: PqBindingRole;
  subjectId: string;
  /** The Ed25519 key the verifier already trusts (pinned, or registered). */
  ed25519PubHex: string;
  /** The ML-DSA key already pinned for this identity, if any: a different one is refused. */
  mldsaPubHex?: string | null;
  now: number;
  /** Refuse a binding dated before this (the pin's own binding, or the key's registration). */
  minIssuedAt?: number;
}

/** Parses the wire shape strictly; codes as `verifyPqKeyBinding`. */
export function pqKeyBindingFromWire(w: unknown): PqKeyBindingWire {
  if (typeof w !== "object" || w === null || Array.isArray(w)) return fail("binding-malformed");
  const o = w as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "ed25519PubHex,issuedAt,mldsaPubHex,role,signature,subjectId,v" || o.v !== 1) fail("binding-malformed");
  if (typeof o.signature !== "string" || o.signature.length > 2 * 65536 || !HEX.test(o.signature)) fail("binding-malformed");
  const s = {
    role: o.role as PqBindingRole,
    subjectId: o.subjectId as string,
    ed25519PubHex: o.ed25519PubHex as string,
    mldsaPubHex: o.mldsaPubHex as string,
    issuedAt: o.issuedAt as number,
  };
  if (typeof s.ed25519PubHex !== "string" || !HEX32.test(s.ed25519PubHex)) fail("binding-malformed");
  if (typeof s.mldsaPubHex !== "string" || s.mldsaPubHex.length !== MLDSA65_PK_HEX_LEN || !HEX_MLDSA.test(s.mldsaPubHex)) fail("binding-malformed");
  if (typeof s.issuedAt !== "number" || !Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) fail("binding-malformed");
  if (!isPqBindingRole(s.role)) fail("binding-role");
  if (typeof s.subjectId !== "string" || !SUBJECT.test(s.subjectId)) fail("binding-subject");
  return { v: 1, ...s, signature: o.signature as string };
}

/**
 * Verifies a binding. Order (both ports): wire shape; role, subject and Ed25519 key against
 * what the verifier expects; a changed ML-DSA pin; dated in the future; older than allowed;
 * the hybrid public key; the hybrid signature over the statement.
 */
export function verifyPqKeyBinding(wire: unknown, expect: PqBindingExpectation): VerifiedPqKeyBinding {
  const w = pqKeyBindingFromWire(wire);
  if (w.role !== expect.role) fail("binding-role");
  if (w.subjectId !== expect.subjectId) fail("binding-subject");
  if (w.ed25519PubHex !== expect.ed25519PubHex.toLowerCase()) fail("binding-key-mismatch");
  if (expect.mldsaPubHex && w.mldsaPubHex !== expect.mldsaPubHex.toLowerCase()) fail("binding-pq-key-changed");
  if (w.issuedAt > expect.now + PQ_BINDING_MAX_SKEW_MS) fail("binding-future");
  if (expect.minIssuedAt !== undefined && w.issuedAt < expect.minIssuedAt) fail("binding-stale");
  const pk = pqBindingPublicKey(w);
  const sig = fromHex(w.signature);
  try {
    parseHybridSigPublicKey(pk);
  } catch {
    fail("bad-public-key");
  }
  try {
    hybridVerify(pk, TAG_PQ_KEY_BINDING, canonicalPqKeyBinding(w), sig);
  } catch (e) {
    if (e instanceof PqHybridError && e.code === "bad-public-key") fail("bad-public-key");
    fail("bad-signature");
  }
  const out: VerifiedPqKeyBinding = Object.freeze({
    role: w.role,
    subjectId: w.subjectId,
    ed25519PubHex: w.ed25519PubHex,
    mldsaPubHex: w.mldsaPubHex,
    issuedAt: w.issuedAt,
    hybridPublicKey: pk,
    keyIdHex: toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk)),
  });
  verified.add(out);
  return out;
}

// ── the gate ─────────────────────────────────────────────────────────────

/** A critical message's signature as it travels: the suite it claims and the bytes. */
export interface SignatureEnvelope {
  suite: SignatureSuite;
  /** Lowercase hex: 64 bytes for `ed25519/v1`, 3373 for the hybrid suite. */
  signature: string;
}

export interface CriticalSignatureInput {
  /** v1-style canonical bytes: `<purpose>|...`. */
  message: Bytes;
  expectedPurpose: string;
  envelope: SignatureEnvelope;
  /** The signer's Ed25519 key as the verifier trusts it (registered or pinned). */
  signerEd25519PubHex: string;
  /** The signer's verified binding, or null when it has none on file. */
  binding: VerifiedPqKeyBinding | null;
  policy: PolicyState;
}

export interface CriticalSignatureVerdict {
  suite: SignatureSuite;
  /** True when the strict profile was in force for this check. */
  strict: boolean;
}

/** Everything before the first `|`, or "" when there is none. */
export function messagePurpose(msg: Bytes): string {
  const bar = msg.indexOf(0x7c);
  if (bar <= 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(msg.subarray(0, bar));
  } catch {
    return "";
  }
}

/**
 * The one check for a critical signature. Order (both ports): purpose grammar and match; the
 * envelope's suite and signature encoding; the binding is a verified one for this signer; the
 * scope's policy (strict needs the hybrid suite and a binding); the signature itself.
 */
export function verifyCriticalSignature(input: CriticalSignatureInput): CriticalSignatureVerdict {
  const { message, expectedPurpose, envelope, binding, policy } = input;
  if (!validatePurposeTag(expectedPurpose)) fail("bad-purpose");
  if (messagePurpose(message) !== expectedPurpose) fail("purpose-mismatch");
  const suite = envelope?.suite;
  if (suite !== "ed25519/v1" && suite !== "hybrid-ed25519-mldsa65/v1") return fail("unknown-suite");
  if (typeof envelope.signature !== "string" || !HEX.test(envelope.signature)) fail("bad-signature");
  const signer = String(input.signerEd25519PubHex ?? "").toLowerCase();
  if (!HEX32.test(signer)) fail("bad-public-key");
  if (binding !== null) {
    if (!verified.has(binding)) fail("no-binding");
    if (binding.ed25519PubHex !== signer) fail("binding-key-mismatch");
  }
  const strict = strictInForce(policy);
  if (strict && suite !== "hybrid-ed25519-mldsa65/v1") fail("strict-requires-hybrid");
  if (strict && binding === null) fail("strict-requires-binding");
  const sig = fromHex(envelope.signature);
  if (suite === "hybrid-ed25519-mldsa65/v1") {
    if (binding === null) return fail("no-binding");
    if (sig.length !== HYBRID_SIG_LEN) fail("bad-signature");
    try {
      hybridVerify(binding.hybridPublicKey, expectedPurpose, message, sig);
    } catch {
      fail("bad-signature");
    }
  } else {
    if (sig.length !== ED25519_SIG_LEN) fail("bad-signature");
    if (!ed25519VerifyStrict(sig, message, fromHex(signer))) fail("bad-signature");
  }
  return { suite, strict };
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
