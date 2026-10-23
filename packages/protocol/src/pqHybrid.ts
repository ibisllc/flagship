/**
 * Architecture v2 hybrid suites, the TypeScript twin of the Rust
 * `flagship-protocol` / `flagship-crypto` crates. DRAFT, pending Q01
 * external cryptographic review; nothing calls this yet.
 * Spec: docs/architecture-v2/pq-suites.md. Vectors: test-vectors/pq-hybrid/.
 */
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha512 } from "@noble/hashes/sha512";
import { gcm } from "@noble/ciphers/aes";
import type { Bytes } from "./types.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const SUITE_HYBRID_SEAL_V1 = 0x0001;
export const SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 = 0x0002;
export const TAG_HYBRID_SEAL_V1 = "flagship/hybrid-seal/v1";
export const TAG_HYBRID_SIG_ED25519_MLDSA65_V1 = "flagship/hybrid-sig/ed25519-mldsa65/v1";
export const TAG_ENVELOPE_V2 = "flagship/envelope/v2";
const TAG_KEY_ID = "flagship/pq-key-id/v1";

export const ENVELOPE_MAX_HEADER_LEN = 1024;
export const ENVELOPE_MAX_BODY_LEN = 1_048_576 + 4096;
export const HYBRID_SEAL_PUBLIC_KEY_LEN = 1216;
export const HYBRID_SEAL_SECRET_KEY_LEN = 32;
export const HYBRID_SEAL_ENC_LEN = 1120;
export const HYBRID_SEAL_TAG_LEN = 16;
export const HYBRID_SEAL_RANDOMNESS_LEN = 64;
export const HYBRID_SEAL_MAX_PLAINTEXT_LEN = 1_048_576;
export const HYBRID_SEAL_MAX_CONTEXT_FIELDS = 16;
export const HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN = 1024;
export const HYBRID_SIG_PUBLIC_KEY_LEN = 1984;
export const HYBRID_SIG_SECRET_KEY_LEN = 64;
export const HYBRID_SIG_LEN = 3373;
export const HYBRID_SIG_MAX_PAYLOAD_LEN = 1_048_576;

const KEY_ID_LEN = 32;
const ML_KEM_PK_LEN = 1184;
const ED_PK_LEN = 32;
const ED_SIG_LEN = 64;
const OKM_LEN = 44;

const SUITE_TAGS: Record<number, string> = {
  [SUITE_HYBRID_SEAL_V1]: TAG_HYBRID_SEAL_V1,
  [SUITE_HYBRID_SIG_ED25519_MLDSA65_V1]: TAG_HYBRID_SIG_ED25519_MLDSA65_V1,
};

/** A refusal; `code` matches the Rust crates and the vectors' `expect`. */
export class PqHybridError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PqHybridError";
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new PqHybridError(code);
};

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);

function concat(...parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const u8 = (n: number): Bytes => Uint8Array.of(n & 0xff);
const u16be = (n: number): Bytes => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
const u32be = (n: number): Bytes =>
  Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
function u64be(n: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}
const lp8 = (b: Bytes): Bytes => concat(u8(b.length), b);

/** Purpose-tag grammar (§2.2); `allowLegacyPb` admits the v1 `pb/...` tags. */
export function validatePurposeTag(tag: string, allowLegacyPb = false): boolean {
  if (tag.length === 0 || tag.length > 128) return false;
  const parts = tag.split("/");
  const ns = parts[0];
  if (!(ns === "flagship" || (allowLegacyPb && ns === "pb"))) return false;
  const segments = parts.length - 2;
  if (segments < 1 || segments > 6) return false;
  for (const seg of parts.slice(1, -1)) {
    if (seg.length === 0 || seg.length > 48 || !/^[a-z0-9][a-z0-9-]*$/.test(seg)) return false;
  }
  return /^v[1-9][0-9]{0,3}$/.test(parts[parts.length - 1]!);
}

// ── v2 envelope header (§3) ───────────────────────────────────────────────

export interface EnvelopeHeaderV2 {
  purpose: string;
  suite: number;
  senderKeyId: Bytes;
  recipientKeyId?: Bytes;
  installationId?: Bytes;
  authorityGeneration?: number;
  sessionNonce?: Bytes;
  policyDigest?: Bytes;
  issuedAt: number;
  expiresAt?: number;
  bodyLen: number;
}

const T = {
  purpose: 0x01,
  suite: 0x02,
  sender: 0x03,
  recipient: 0x04,
  installation: 0x05,
  generation: 0x06,
  session: 0x07,
  policy: 0x08,
  issued: 0x09,
  expires: 0x0a,
  bodyLen: 0x0b,
} as const;

const FIXED_LEN: Record<number, number> = {
  [T.suite]: 2,
  [T.sender]: 32,
  [T.recipient]: 32,
  [T.installation]: 16,
  [T.generation]: 8,
  [T.session]: 32,
  [T.policy]: 64,
  [T.issued]: 8,
  [T.expires]: 8,
  [T.bodyLen]: 4,
};

const isUint = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function validateHeader(h: EnvelopeHeaderV2): void {
  const p = utf8(h.purpose);
  if (p.length === 0 || p.length > 128) fail("header-field-length");
  if (!validatePurposeTag(h.purpose)) fail("header-bad-value");
  const fixed: Array<[Bytes | undefined, number]> = [
    [h.senderKeyId, 32],
    [h.recipientKeyId, 32],
    [h.installationId, 16],
    [h.sessionNonce, 32],
    [h.policyDigest, 64],
  ];
  for (const [v, n] of fixed) if (v !== undefined && v.length !== n) fail("header-field-length");
  if (!SUITE_TAGS[h.suite]) fail("header-bad-value");
  for (const v of [h.issuedAt, h.expiresAt, h.authorityGeneration]) {
    if (v !== undefined && !isUint(v)) fail("header-bad-value");
  }
  if (h.expiresAt !== undefined && h.expiresAt <= h.issuedAt) fail("header-bad-value");
  if (!isUint(h.bodyLen) || h.bodyLen > ENVELOPE_MAX_BODY_LEN) fail("header-bad-value");
  if (h.suite === SUITE_HYBRID_SEAL_V1 && h.recipientKeyId === undefined) fail("header-missing-field");
}

export function encodeEnvelopeHeader(h: EnvelopeHeaderV2): Bytes {
  validateHeader(h);
  const tlv: Bytes[] = [];
  const put = (ty: number, v: Bytes) => tlv.push(u8(ty), u16be(v.length), v);
  put(T.purpose, utf8(h.purpose));
  put(T.suite, u16be(h.suite));
  put(T.sender, h.senderKeyId);
  if (h.recipientKeyId) put(T.recipient, h.recipientKeyId);
  if (h.installationId) put(T.installation, h.installationId);
  if (h.authorityGeneration !== undefined) put(T.generation, u64be(h.authorityGeneration));
  if (h.sessionNonce) put(T.session, h.sessionNonce);
  if (h.policyDigest) put(T.policy, h.policyDigest);
  put(T.issued, u64be(h.issuedAt));
  if (h.expiresAt !== undefined) put(T.expires, u64be(h.expiresAt));
  put(T.bodyLen, u32be(h.bodyLen));
  const body = concat(...tlv);
  const out = concat(lp8(utf8(TAG_ENVELOPE_V2)), u16be(body.length), body);
  if (out.length > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large");
  return out;
}

function readU64(v: Bytes): number {
  const n = new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0);
  return n > BigInt(MAX_SAFE_INTEGER) ? Number.NaN : Number(n);
}

/** Decodes a header at the start of `bytes`; check order as in §3.3. */
export function decodeEnvelopeHeader(bytes: Bytes): { header: EnvelopeHeaderV2; length: number } {
  const magic = lp8(utf8(TAG_ENVELOPE_V2));
  if (bytes.length < magic.length) fail("header-truncated");
  if (!equalBytes(bytes.subarray(0, magic.length), magic)) fail("header-bad-magic");
  if (bytes.length < magic.length + 2) fail("header-truncated");
  const tlvLen = (bytes[magic.length]! << 8) | bytes[magic.length + 1]!;
  const total = magic.length + 2 + tlvLen;
  if (total > ENVELOPE_MAX_HEADER_LEN) fail("header-too-large");
  if (bytes.length < total) fail("header-truncated");
  const tlv = bytes.subarray(magic.length + 2, total);

  const f: Partial<Record<number, Bytes>> = {};
  let purpose: string | undefined;
  let prev = 0;
  let o = 0;
  while (o < tlv.length) {
    if (o + 3 > tlv.length) fail("header-truncated");
    const ty = tlv[o]!;
    const len = (tlv[o + 1]! << 8) | tlv[o + 2]!;
    o += 3;
    if (o + len > tlv.length) fail("header-truncated");
    const value = tlv.subarray(o, o + len);
    o += len;
    if (ty < T.purpose || ty > T.bodyLen) fail("header-unknown-field");
    if (ty === prev) fail("header-duplicate-field");
    if (ty < prev) fail("header-field-order");
    prev = ty;
    if (ty === T.purpose) {
      if (len === 0 || len > 128) fail("header-field-length");
      try {
        purpose = new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch {
        fail("header-bad-value");
      }
    } else if (len !== FIXED_LEN[ty]) {
      fail("header-field-length");
    }
    if (ty === T.suite && !SUITE_TAGS[(value[0]! << 8) | value[1]!]) fail("header-bad-value");
    f[ty] = value;
  }
  const req = (ty: number): Bytes => f[ty] ?? fail("header-missing-field");
  if (purpose === undefined) return fail("header-missing-field");
  const suiteB = req(T.suite);
  const sender = req(T.sender);
  const issued = req(T.issued);
  const bodyLenB = req(T.bodyLen);
  const opt = (ty: number): Bytes | undefined => (f[ty] ? Uint8Array.from(f[ty]!) : undefined);
  const header: EnvelopeHeaderV2 = {
    purpose,
    suite: (suiteB[0]! << 8) | suiteB[1]!,
    senderKeyId: Uint8Array.from(sender),
    issuedAt: readU64(issued),
    bodyLen: new DataView(bodyLenB.buffer, bodyLenB.byteOffset, 4).getUint32(0),
  };
  const recipient = opt(T.recipient);
  if (recipient) header.recipientKeyId = recipient;
  const installation = opt(T.installation);
  if (installation) header.installationId = installation;
  if (f[T.generation]) header.authorityGeneration = readU64(f[T.generation]!);
  const session = opt(T.session);
  if (session) header.sessionNonce = session;
  const policy = opt(T.policy);
  if (policy) header.policyDigest = policy;
  if (f[T.expires]) header.expiresAt = readU64(f[T.expires]!);
  validateHeader(header);
  if (!equalBytes(encodeEnvelopeHeader(header), bytes.subarray(0, total))) fail("header-bad-value");
  return { header, length: total };
}

/** Decodes `header || body`; the body must be exactly `bodyLen` bytes. */
export function decodeEnvelope(bytes: Bytes): {
  header: EnvelopeHeaderV2;
  headerBytes: Bytes;
  body: Bytes;
} {
  const { header, length } = decodeEnvelopeHeader(bytes);
  const body = bytes.subarray(length);
  if (body.length !== header.bodyLen) fail("body-length");
  return { header, headerBytes: bytes.subarray(0, length), body };
}

// ── Key ids (§2.3) ────────────────────────────────────────────────────────

export function pqKeyId(suite: number, publicKey: Bytes): Bytes {
  const d = sha512(concat(lp8(utf8(TAG_KEY_ID)), u16be(suite), u16be(publicKey.length), publicKey));
  return d.slice(0, KEY_ID_LEN);
}

// ── flagship/hybrid-seal/v1 (§4) ──────────────────────────────────────────

const X25519_PROBE = new Uint8Array(32).fill(0x5a);

// FIPS 203 §7.2 modulus check: every 12-bit coefficient of t̂ is below q.
function mlKemModulusOk(ek: Bytes): boolean {
  for (let i = 0; i < 1152; i += 3) {
    const b0 = ek[i]!;
    const b1 = ek[i + 1]!;
    const b2 = ek[i + 2]!;
    if ((b0 | ((b1 & 0x0f) << 8)) >= 3329) return false;
    if (((b1 >> 4) | (b2 << 4)) >= 3329) return false;
  }
  return true;
}

/** Validates an X-Wing encapsulation key (length, ML-KEM modulus, X25519 not small order). */
export function parseHybridSealPublicKey(pk: Bytes): Bytes {
  if (pk.length !== HYBRID_SEAL_PUBLIC_KEY_LEN) fail("bad-public-key");
  if (!mlKemModulusOk(pk.subarray(0, ML_KEM_PK_LEN))) fail("bad-public-key");
  try {
    x25519.getSharedSecret(X25519_PROBE, pk.subarray(ML_KEM_PK_LEN));
  } catch {
    fail("bad-public-key");
  }
  return pk;
}

export function hybridSealKeygen(seed: Bytes): { publicKey: Bytes; secretKey: Bytes } {
  if (seed.length !== HYBRID_SEAL_SECRET_KEY_LEN) fail("bad-secret-key");
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  return { publicKey: parseHybridSealPublicKey(publicKey), secretKey: Uint8Array.from(seed) };
}

export interface HybridSealOptions {
  purpose: string;
  senderKeyId: Bytes;
  issuedAt: number;
  expiresAt?: number;
  installationId?: Bytes;
  authorityGeneration?: number;
  sessionNonce?: Bytes;
  policyDigest?: Bytes;
}

function checkSealInputs(purpose: string, context: Bytes[]): void {
  if (!validatePurposeTag(purpose)) fail("bad-purpose");
  if (
    context.length > HYBRID_SEAL_MAX_CONTEXT_FIELDS ||
    context.some((c) => c.length > HYBRID_SEAL_MAX_CONTEXT_FIELD_LEN)
  ) {
    fail("context-too-large");
  }
}

/** The HKDF `info` (§4.3). Exported for the vectors. */
export function hybridSealKdfInfo(
  headerBytes: Bytes,
  header: EnvelopeHeaderV2,
  context: Bytes[],
  enc: Bytes,
): Bytes {
  const ctx: Bytes[] = [u8(context.length)];
  for (const c of context) ctx.push(u16be(c.length), c);
  return concat(
    lp8(utf8(TAG_HYBRID_SEAL_V1)),
    u16be(SUITE_HYBRID_SEAL_V1),
    lp8(utf8(header.purpose)),
    header.senderKeyId,
    header.recipientKeyId ?? new Uint8Array(KEY_ID_LEN),
    u32be(headerBytes.length),
    headerBytes,
    ...ctx,
    enc,
  );
}

function deriveSealKeys(ss: Bytes, info: Bytes): { key: Bytes; nonce: Bytes } {
  const okm = hkdf(sha512, ss, utf8(TAG_HYBRID_SEAL_V1), info, OKM_LEN);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, OKM_LEN) };
}

/**
 * Seal with caller-supplied encapsulation randomness (ML-KEM coins, then the
 * X25519 ephemeral secret). For vectors only: reusing `eseed` reuses the AES
 * key and nonce.
 */
export function hybridSealWithRandomness(
  recipientPublicKey: Bytes,
  opts: HybridSealOptions,
  context: Bytes[],
  plaintext: Bytes,
  eseed: Bytes,
): Bytes {
  const pk = parseHybridSealPublicKey(recipientPublicKey);
  checkSealInputs(opts.purpose, context);
  if (plaintext.length > HYBRID_SEAL_MAX_PLAINTEXT_LEN) fail("plaintext-too-large");
  if (eseed.length !== HYBRID_SEAL_RANDOMNESS_LEN) fail("randomness");
  const header: EnvelopeHeaderV2 = {
    purpose: opts.purpose,
    suite: SUITE_HYBRID_SEAL_V1,
    senderKeyId: opts.senderKeyId,
    recipientKeyId: pqKeyId(SUITE_HYBRID_SEAL_V1, pk),
    issuedAt: opts.issuedAt,
    bodyLen: HYBRID_SEAL_ENC_LEN + plaintext.length + HYBRID_SEAL_TAG_LEN,
  };
  if (opts.expiresAt !== undefined) header.expiresAt = opts.expiresAt;
  if (opts.installationId) header.installationId = opts.installationId;
  if (opts.authorityGeneration !== undefined) header.authorityGeneration = opts.authorityGeneration;
  if (opts.sessionNonce) header.sessionNonce = opts.sessionNonce;
  if (opts.policyDigest) header.policyDigest = opts.policyDigest;
  const headerBytes = encodeEnvelopeHeader(header);
  const { cipherText: enc, sharedSecret } = ml_kem768_x25519.encapsulate(pk, eseed);
  const { key, nonce } = deriveSealKeys(sharedSecret, hybridSealKdfInfo(headerBytes, header, context, enc));
  sharedSecret.fill(0);
  const sealed = gcm(key, nonce, concat(headerBytes, enc)).encrypt(plaintext);
  key.fill(0);
  return concat(headerBytes, enc, sealed);
}

export function hybridSeal(
  recipientPublicKey: Bytes,
  opts: HybridSealOptions,
  context: Bytes[],
  plaintext: Bytes,
): Bytes {
  const eseed = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN));
  try {
    return hybridSealWithRandomness(recipientPublicKey, opts, context, plaintext, eseed);
  } finally {
    eseed.fill(0);
  }
}

/** Opens a seal; every failure past the header checks is `decrypt-failed`. */
export function hybridOpen(
  recipientSecretKey: Bytes,
  expectedPurpose: string,
  context: Bytes[],
  sealed: Bytes,
): { header: EnvelopeHeaderV2; plaintext: Bytes } {
  checkSealInputs(expectedPurpose, context);
  const { publicKey } = hybridSealKeygen(recipientSecretKey);
  const { header, headerBytes, body } = decodeEnvelope(sealed);
  if (header.suite !== SUITE_HYBRID_SEAL_V1) fail("suite-mismatch");
  if (header.purpose !== expectedPurpose) fail("purpose-mismatch");
  const myId = pqKeyId(SUITE_HYBRID_SEAL_V1, publicKey);
  if (!header.recipientKeyId || !equalBytes(header.recipientKeyId, myId)) fail("recipient-mismatch");
  if (body.length < HYBRID_SEAL_ENC_LEN + HYBRID_SEAL_TAG_LEN) fail("body-length");
  if (body.length - HYBRID_SEAL_ENC_LEN - HYBRID_SEAL_TAG_LEN > HYBRID_SEAL_MAX_PLAINTEXT_LEN) {
    fail("plaintext-too-large");
  }
  const enc = body.subarray(0, HYBRID_SEAL_ENC_LEN);
  let ss: Bytes;
  try {
    ss = ml_kem768_x25519.decapsulate(enc, recipientSecretKey);
  } catch {
    return fail("decrypt-failed");
  }
  const { key, nonce } = deriveSealKeys(ss, hybridSealKdfInfo(headerBytes, header, context, enc));
  ss.fill(0);
  try {
    const plaintext = gcm(key, nonce, concat(headerBytes, enc)).decrypt(body.subarray(HYBRID_SEAL_ENC_LEN));
    return { header, plaintext };
  } catch {
    return fail("decrypt-failed");
  } finally {
    key.fill(0);
  }
}

// ── flagship/hybrid-sig/ed25519-mldsa65/v1 (§5) ───────────────────────────

// Strict profile shared with ed25519-dalek's verify_strict: canonical,
// torsion-free, non-identity A and R. With both torsion-free, noble's
// cofactored equation agrees with the cofactorless one.
function strictPoint(b: Bytes): boolean {
  try {
    const p = ed25519.Point.fromBytes(b, false);
    return equalBytes(p.toBytes(), b) && !p.isSmallOrder() && p.isTorsionFree();
  } catch {
    return false;
  }
}

function edVerifyStrict(sig: Bytes, msg: Bytes, pk: Bytes): boolean {
  if (!strictPoint(sig.subarray(0, 32))) return false;
  try {
    return ed25519.verify(sig, msg, pk, { zip215: false });
  } catch {
    return false;
  }
}

export function parseHybridSigPublicKey(pk: Bytes): Bytes {
  if (pk.length !== HYBRID_SIG_PUBLIC_KEY_LEN) fail("bad-public-key");
  if (!strictPoint(pk.subarray(0, ED_PK_LEN))) fail("bad-public-key");
  return pk;
}

/** Secret key = Ed25519 seed (32) || ML-DSA-65 KeyGen_internal seed (32), independent. */
export function hybridSigKeygen(edSeed: Bytes, mldsaSeed: Bytes): { publicKey: Bytes; secretKey: Bytes } {
  if (edSeed.length !== 32 || mldsaSeed.length !== 32) fail("bad-secret-key");
  const edPk = ed25519.getPublicKey(edSeed);
  const ml = ml_dsa65.keygen(mldsaSeed);
  ml.secretKey.fill(0);
  const publicKey = concat(edPk, ml.publicKey);
  try {
    parseHybridSigPublicKey(publicKey);
  } catch {
    fail("bad-secret-key");
  }
  return { publicKey, secretKey: concat(edSeed, mldsaSeed) };
}

/** The signed message representative M' (§5.2). */
export function hybridSigMessage(publicKey: Bytes, purpose: string, payload: Bytes): Bytes {
  if (!validatePurposeTag(purpose)) fail("bad-purpose");
  if (payload.length > HYBRID_SIG_MAX_PAYLOAD_LEN) fail("payload-too-large");
  return concat(
    lp8(utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1)),
    u16be(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1),
    publicKey,
    lp8(utf8(purpose)),
    u32be(payload.length),
    payload,
  );
}

/** Signs; `deterministic` uses ML-DSA's rnd = 0^32 variant (vectors), else hedged. */
export function hybridSign(
  secretKey: Bytes,
  purpose: string,
  payload: Bytes,
  opts: { deterministic?: boolean } = {},
): Bytes {
  if (secretKey.length !== HYBRID_SIG_SECRET_KEY_LEN) fail("bad-secret-key");
  const edSeed = secretKey.subarray(0, 32);
  const { publicKey } = hybridSigKeygen(edSeed, secretKey.subarray(32));
  const m = hybridSigMessage(publicKey, purpose, payload);
  const ml = ml_dsa65.keygen(secretKey.subarray(32));
  try {
    const mlSig = ml_dsa65.sign(m, ml.secretKey, {
      context: utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1),
      ...(opts.deterministic ? { extraEntropy: false as const } : {}),
    });
    return concat(ed25519.sign(m, edSeed), mlSig);
  } finally {
    ml.secretKey.fill(0);
  }
}

/** Throws unless BOTH components verify over M'. */
export function hybridVerify(publicKey: Bytes, purpose: string, payload: Bytes, signature: Bytes): void {
  parseHybridSigPublicKey(publicKey);
  const m = hybridSigMessage(publicKey, purpose, payload);
  if (signature.length !== HYBRID_SIG_LEN) fail("bad-signature");
  const edOk = edVerifyStrict(signature.subarray(0, ED_SIG_LEN), m, publicKey.subarray(0, ED_PK_LEN));
  let mlOk = false;
  try {
    mlOk = ml_dsa65.verify(signature.subarray(ED_SIG_LEN), m, publicKey.subarray(ED_PK_LEN), {
      context: utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1),
    });
  } catch {
    mlOk = false;
  }
  if (!(edOk && mlOk)) fail("bad-signature");
}
