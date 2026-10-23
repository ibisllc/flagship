#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the architecture-v2 hybrid suites
 * (docs/architecture-v2/pq-suites.md). The TypeScript port
 * (packages/protocol/src/pqHybrid.ts, @noble/post-quantum) GENERATES them;
 * packages/protocol/tests/pqHybridVectors.test.ts and
 * rust/crates/flagship-crypto/tests/pq_hybrid_vectors.rs both re-derive every
 * deterministic output byte for byte and check every refusal code.
 *
 * Run:          npx tsx tools/pq-hybrid-vectors.ts
 * CI freshness: npx tsx tools/pq-hybrid-vectors.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { sha512 } from "@noble/hashes/sha512";
import {
  SUITE_HYBRID_SEAL_V1,
  SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  TAG_HYBRID_SIG_ED25519_MLDSA65_V1,
  encodeEnvelopeHeader,
  hybridSealKeygen,
  hybridSealWithRandomness,
  hybridSigKeygen,
  hybridSigMessage,
  hybridSign,
  pqKeyId,
  type EnvelopeHeaderV2,
  type HybridSealOptions,
} from "../packages/protocol/src/pqHybrid.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/pq-hybrid/vectors.json");

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const counting = (n: number, start: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const flip = (b: Uint8Array, i: number, mask = 0x01): Uint8Array => {
  const c = Uint8Array.from(b);
  c[i] = c[i]! ^ mask;
  return c;
};
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

function headerJson(h: EnvelopeHeaderV2): Record<string, unknown> {
  const j: Record<string, unknown> = {
    purpose: h.purpose,
    suite: h.suite,
    senderKeyId: hex(h.senderKeyId),
    issuedAt: h.issuedAt,
    bodyLen: h.bodyLen,
  };
  if (h.recipientKeyId) j.recipientKeyId = hex(h.recipientKeyId);
  if (h.installationId) j.installationId = hex(h.installationId);
  if (h.authorityGeneration !== undefined) j.authorityGeneration = h.authorityGeneration;
  if (h.sessionNonce) j.sessionNonce = hex(h.sessionNonce);
  if (h.policyDigest) j.policyDigest = hex(h.policyDigest);
  if (h.expiresAt !== undefined) j.expiresAt = h.expiresAt;
  return j;
}

// Raw TLV builder for malformed headers that the encoder refuses to produce.
function rawHeader(tlvs: Array<[number, Uint8Array]>, magicTag = "flagship/envelope/v2"): Uint8Array {
  const body = cat(...tlvs.map(([t, v]) => cat(Uint8Array.of(t, v.length >> 8, v.length & 0xff), v)));
  const m = utf8(magicTag);
  return cat(Uint8Array.of(m.length), m, Uint8Array.of(body.length >> 8, body.length & 0xff), body);
}
const be = (n: number | bigint, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  let v = BigInt(n);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

// ── keys ──
const recipientA = hybridSealKeygen(counting(32, 0x10));
const recipientB = hybridSealKeygen(counting(32, 0x80));
const signerA = { edSeed: counting(32, 0x20), mldsaSeed: counting(32, 0x40) };
const signerB = { edSeed: counting(32, 0xa0), mldsaSeed: counting(32, 0xc0) };
const sigA = hybridSigKeygen(signerA.edSeed, signerA.mldsaSeed);
const sigB = hybridSigKeygen(signerB.edSeed, signerB.mldsaSeed);
const senderKeyId = pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, sigA.publicKey);

const keyIds = [
  { suite: SUITE_HYBRID_SEAL_V1, publicKey: hex(recipientA.publicKey), keyId: hex(pqKeyId(SUITE_HYBRID_SEAL_V1, recipientA.publicKey)) },
  { suite: SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, publicKey: hex(sigA.publicKey), keyId: hex(senderKeyId) },
];

// ── raw X-Wing (beyond the draft's own KATs) ──
const kem = [
  { seed: counting(32, 0x10), eseed: counting(64, 0x33) },
  { seed: counting(32, 0x80), eseed: fill(64, 0xee) },
].map(({ seed, eseed }) => {
  const { publicKey } = ml_kem768_x25519.keygen(seed);
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(publicKey, eseed);
  return { seed: hex(seed), publicKey: hex(publicKey), eseed: hex(eseed), enc: hex(cipherText), sharedSecret: hex(sharedSecret) };
});

// ── envelope header ──
const fullHeader: EnvelopeHeaderV2 = {
  purpose: "flagship/boot-unlock-response/v2",
  suite: SUITE_HYBRID_SEAL_V1,
  senderKeyId,
  recipientKeyId: pqKeyId(SUITE_HYBRID_SEAL_V1, recipientA.publicKey),
  installationId: counting(16, 0x01),
  authorityGeneration: 3,
  sessionNonce: counting(32, 0x50),
  policyDigest: sha512(utf8("policy")),
  issuedAt: 1_760_000_000_000,
  expiresAt: 1_760_000_300_000,
  bodyLen: 1_136,
};
const minimalHeader: EnvelopeHeaderV2 = {
  purpose: "flagship/release-root/v2",
  suite: SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  senderKeyId,
  issuedAt: 0,
  bodyLen: 0,
};
const envelopeValid = [fullHeader, minimalHeader].map((h) => ({ header: headerJson(h), hex: hex(encodeEnvelopeHeader(h)) }));

const P = utf8("flagship/x/v1");
const S = be(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, 2);
const K = fill(32, 7);
const I = be(1, 8);
const B = be(0, 4);
const minimalTlv: Array<[number, Uint8Array]> = [[1, P], [2, S], [3, K], [9, I], [11, B]];
const okMinimal = rawHeader(minimalTlv);
const envelopeInvalid: Array<{ name: string; hex: string; expect: string }> = [
  { name: "bad-magic", hex: hex(rawHeader(minimalTlv, "flagship/envelope/v3")), expect: "header-bad-magic" },
  { name: "empty", hex: "", expect: "header-truncated" },
  { name: "truncated-tlv", hex: hex(okMinimal.subarray(0, okMinimal.length - 1)), expect: "header-truncated" },
  { name: "tlv-length-overruns", hex: hex(cat(okMinimal.subarray(0, 21), be(8, 2), Uint8Array.of(1, 0, 50), utf8("abcde"))), expect: "header-truncated" },
  { name: "unknown-field", hex: hex(rawHeader([...minimalTlv, [0x0c, Uint8Array.of(1)]])), expect: "header-unknown-field" },
  { name: "unknown-field-zero", hex: hex(rawHeader([[0, Uint8Array.of(1)], ...minimalTlv])), expect: "header-unknown-field" },
  { name: "duplicate-field", hex: hex(rawHeader([[1, P], [2, S], [3, K], [3, K], [9, I], [11, B]])), expect: "header-duplicate-field" },
  { name: "out-of-order", hex: hex(rawHeader([[1, P], [3, K], [2, S], [9, I], [11, B]])), expect: "header-field-order" },
  { name: "sender-wrong-length", hex: hex(rawHeader([[1, P], [2, S], [3, fill(31, 7)], [9, I], [11, B]])), expect: "header-field-length" },
  { name: "empty-optional-present", hex: hex(rawHeader([[1, P], [2, S], [3, K], [5, new Uint8Array(0)], [9, I], [11, B]])), expect: "header-field-length" },
  { name: "empty-purpose", hex: hex(rawHeader([[1, new Uint8Array(0)], [2, S], [3, K], [9, I], [11, B]])), expect: "header-field-length" },
  { name: "missing-sender", hex: hex(rawHeader([[1, P], [2, S], [9, I], [11, B]])), expect: "header-missing-field" },
  { name: "missing-body-len", hex: hex(rawHeader([[1, P], [2, S], [3, K], [9, I]])), expect: "header-missing-field" },
  { name: "seal-without-recipient", hex: hex(rawHeader([[1, P], [2, be(1, 2)], [3, K], [9, I], [11, B]])), expect: "header-missing-field" },
  { name: "unknown-suite", hex: hex(rawHeader([[1, P], [2, be(0x0003, 2)], [3, K], [9, I], [11, B]])), expect: "header-bad-value" },
  { name: "legacy-purpose", hex: hex(rawHeader([[1, utf8("pb/announce/v1")], [2, S], [3, K], [9, I], [11, B]])), expect: "header-bad-value" },
  { name: "purpose-not-utf8", hex: hex(rawHeader([[1, Uint8Array.of(0xff, 0xfe)], [2, S], [3, K], [9, I], [11, B]])), expect: "header-bad-value" },
  { name: "issued-at-above-safe-integer", hex: hex(rawHeader([[1, P], [2, S], [3, K], [9, be(2n ** 53n, 8)], [11, B]])), expect: "header-bad-value" },
  { name: "expires-not-after-issued", hex: hex(rawHeader([[1, P], [2, S], [3, K], [9, I], [10, I], [11, B]])), expect: "header-bad-value" },
  { name: "body-len-too-large", hex: hex(rawHeader([[1, P], [2, S], [3, K], [9, I], [11, be(1_048_576 + 4097, 4)]])), expect: "header-bad-value" },
  { name: "header-too-large", hex: hex(cat(okMinimal.subarray(0, 21), be(1024 - 23 + 1, 2), new Uint8Array(1002))), expect: "header-too-large" },
];

// ── seal ──
const ctx = [utf8("home.harry.flagship.services"), counting(32, 0x99), new Uint8Array(0)];
type SealCase = { name: string; recipientSeed: Uint8Array; options: HybridSealOptions; context: Uint8Array[]; plaintext: Uint8Array; eseed: Uint8Array };
const sealCases: SealCase[] = [
  {
    name: "unlock-response",
    recipientSeed: counting(32, 0x10),
    options: { purpose: "flagship/boot-unlock-response/v2", senderKeyId, issuedAt: 1_760_000_000_000, expiresAt: 1_760_000_300_000, sessionNonce: counting(32, 0x50), installationId: counting(16, 1), authorityGeneration: 3 },
    context: ctx,
    plaintext: utf8("luks-volume-key-0123456789abcdef"),
    eseed: counting(64, 0x33),
  },
  {
    name: "empty-plaintext-no-context",
    recipientSeed: counting(32, 0x80),
    options: { purpose: "flagship/backup-key-grant/v2", senderKeyId: fill(32, 0), issuedAt: 0 },
    context: [],
    plaintext: new Uint8Array(0),
    eseed: fill(64, 0xee),
  },
  {
    name: "kilobyte",
    recipientSeed: counting(32, 0x10),
    options: { purpose: "flagship/peer-key-grant/v2", senderKeyId, issuedAt: 1_792_000_000_000, policyDigest: sha512(utf8("policy")) },
    context: [utf8("a")],
    plaintext: counting(1024, 0),
    eseed: counting(64, 0x01),
  },
];
const sealValid = sealCases.map((c) => {
  const kp = hybridSealKeygen(c.recipientSeed);
  const sealed = hybridSealWithRandomness(kp.publicKey, c.options, c.context, c.plaintext, c.eseed);
  const o = c.options;
  const options: Record<string, unknown> = { purpose: o.purpose, senderKeyId: hex(o.senderKeyId), issuedAt: o.issuedAt };
  if (o.expiresAt !== undefined) options.expiresAt = o.expiresAt;
  if (o.installationId) options.installationId = hex(o.installationId);
  if (o.authorityGeneration !== undefined) options.authorityGeneration = o.authorityGeneration;
  if (o.sessionNonce) options.sessionNonce = hex(o.sessionNonce);
  if (o.policyDigest) options.policyDigest = hex(o.policyDigest);
  return {
    name: c.name,
    recipientSeed: hex(c.recipientSeed),
    recipientPublicKey: hex(kp.publicKey),
    options,
    context: c.context.map(hex),
    plaintext: hex(c.plaintext),
    eseed: hex(c.eseed),
    sealed: hex(sealed),
  };
});

const base = sealValid[0]!;
const baseSealed = unhex(base.sealed);
const hdrLen = 23 + ((baseSealed[21]! << 8) | baseSealed[22]!);
const encAt = hdrLen;
const ctAt = hdrLen + 1120;
const tagAt = baseSealed.length - 16;
const reheader = (h: Partial<EnvelopeHeaderV2>): Uint8Array => {
  const orig: EnvelopeHeaderV2 = {
    purpose: "flagship/boot-unlock-response/v2",
    suite: SUITE_HYBRID_SEAL_V1,
    senderKeyId,
    recipientKeyId: pqKeyId(SUITE_HYBRID_SEAL_V1, recipientA.publicKey),
    installationId: counting(16, 1),
    authorityGeneration: 3,
    sessionNonce: counting(32, 0x50),
    issuedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_300_000,
    bodyLen: baseSealed.length - hdrLen,
    ...h,
  };
  return cat(encodeEnvelopeHeader(orig), baseSealed.subarray(hdrLen));
};
const zeroX = Uint8Array.from(baseSealed);
zeroX.fill(0, encAt + 1088, encAt + 1120);
const P0 = "flagship/boot-unlock-response/v2";
const ctx0 = base.context;
const sealInvalid = [
  { name: "tampered-enc-mlkem", sealed: flip(baseSealed, encAt + 5), expect: "decrypt-failed" },
  { name: "tampered-enc-x25519", sealed: flip(baseSealed, encAt + 1100), expect: "decrypt-failed" },
  { name: "zero-x25519-enc", sealed: zeroX, expect: "decrypt-failed" },
  { name: "tampered-ciphertext", sealed: flip(baseSealed, ctAt), expect: "decrypt-failed" },
  { name: "tampered-tag", sealed: flip(baseSealed, tagAt + 15, 0x80), expect: "decrypt-failed" },
  { name: "tampered-header-sender", sealed: reheader({ senderKeyId: flip(senderKeyId, 0) }), expect: "decrypt-failed" },
  { name: "tampered-header-issued-at", sealed: reheader({ issuedAt: 1_760_000_000_001 }), expect: "decrypt-failed" },
  { name: "header-optional-field-stripped", sealed: reheader({ sessionNonce: undefined }), expect: "decrypt-failed" },
  { name: "purpose-rewritten", sealed: reheader({ purpose: "flagship/peer-key-grant/v2" }), expectedPurpose: "flagship/peer-key-grant/v2", expect: "decrypt-failed" },
  { name: "wrong-expected-purpose", sealed: baseSealed, expectedPurpose: "flagship/peer-key-grant/v2", expect: "purpose-mismatch" },
  { name: "suite-rewritten", sealed: reheader({ suite: SUITE_HYBRID_SIG_ED25519_MLDSA65_V1 }), expect: "suite-mismatch" },
  { name: "wrong-recipient", sealed: baseSealed, recipientSeed: hex(counting(32, 0x80)), expect: "recipient-mismatch" },
  { name: "recipient-id-rewritten", sealed: reheader({ recipientKeyId: pqKeyId(SUITE_HYBRID_SEAL_V1, recipientB.publicKey) }), recipientSeed: hex(counting(32, 0x80)), expect: "decrypt-failed" },
  { name: "wrong-context-value", sealed: baseSealed, context: [hex(utf8("home.sarah.flagship.services")), ctx0[1], ctx0[2]], expect: "decrypt-failed" },
  { name: "context-field-dropped", sealed: baseSealed, context: [ctx0[0], ctx0[1]], expect: "decrypt-failed" },
  { name: "context-field-added", sealed: baseSealed, context: [...ctx0, ""], expect: "decrypt-failed" },
  { name: "context-fields-merged", sealed: baseSealed, context: [ctx0[0]! + ctx0[1]!, ctx0[2]], expect: "decrypt-failed" },
  { name: "context-too-many-fields", sealed: baseSealed, context: Array.from({ length: 17 }, () => ""), expect: "context-too-large" },
  { name: "context-field-too-long", sealed: baseSealed, context: [hex(new Uint8Array(1025))], expect: "context-too-large" },
  { name: "truncated", sealed: baseSealed.subarray(0, baseSealed.length - 1), expect: "body-length" },
  { name: "trailing-byte", sealed: cat(baseSealed, Uint8Array.of(0)), expect: "body-length" },
  { name: "body-shorter-than-enc-and-tag", sealed: cat(reheader({ bodyLen: 1135 }).subarray(0, hdrLen), baseSealed.subarray(hdrLen, hdrLen + 1135)), expect: "body-length" },
  { name: "bad-expected-purpose", sealed: baseSealed, expectedPurpose: "pb/announce/v1", expect: "bad-purpose" },
  { name: "not-an-envelope", sealed: baseSealed.subarray(hdrLen), expect: "header-bad-magic" },
].map((c) => ({
  name: c.name,
  recipientSeed: c.recipientSeed ?? base.recipientSeed,
  expectedPurpose: c.expectedPurpose ?? P0,
  context: c.context ?? ctx0,
  sealed: hex(c.sealed),
  expect: c.expect,
}));

const x25519Order8 = "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800";
const pkA = recipientA.publicKey;
const withX = (x: string): string => hex(cat(pkA.subarray(0, 1184), unhex(x)));
const badModulus = Uint8Array.from(pkA);
badModulus[0] = 0xff;
badModulus[1] = 0x0f;
const sealRejectPublicKeys = [
  { name: "x25519-zero", publicKey: withX("00".repeat(32)), expect: "bad-public-key" },
  { name: "x25519-one", publicKey: withX("01" + "00".repeat(31)), expect: "bad-public-key" },
  { name: "x25519-order-8", publicKey: withX(x25519Order8), expect: "bad-public-key" },
  { name: "mlkem-modulus", publicKey: hex(badModulus), expect: "bad-public-key" },
  { name: "short", publicKey: hex(pkA.subarray(0, 1215)), expect: "bad-public-key" },
];
const sealRejectInputs = [
  { name: "plaintext-too-large", plaintextLen: 1_048_577, purpose: P0, contextFields: 0, expect: "plaintext-too-large" },
  { name: "bad-purpose", plaintextLen: 1, purpose: "flagship/Upper/v1", contextFields: 0, expect: "bad-purpose" },
  { name: "context-too-many-fields", plaintextLen: 1, purpose: P0, contextFields: 17, expect: "context-too-large" },
];

// ── hybrid signature ──
const sigTag = TAG_HYBRID_SIG_ED25519_MLDSA65_V1;
const fullHeaderBytes = encodeEnvelopeHeader({ ...minimalHeader, bodyLen: 5 });
const sigCases = [
  { name: "empty-payload", signer: signerA, purpose: "flagship/release-root/v2", payload: new Uint8Array(0) },
  { name: "text-payload", signer: signerA, purpose: "flagship/device-enrollment/v2", payload: utf8("enroll device 0123456789abcdef") },
  { name: "envelope-payload", signer: signerB, purpose: "flagship/release-root/v2", payload: cat(fullHeaderBytes, utf8("hello")) },
];
const sigValid = sigCases.map((c) => {
  const kp = hybridSigKeygen(c.signer.edSeed, c.signer.mldsaSeed);
  const sig = hybridSign(kp.secretKey, c.purpose, c.payload, { deterministic: true });
  return {
    name: c.name,
    edSeed: hex(c.signer.edSeed),
    mldsaSeed: hex(c.signer.mldsaSeed),
    publicKey: hex(kp.publicKey),
    keyId: hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, kp.publicKey)),
    purpose: c.purpose,
    payload: hex(c.payload),
    messageSha512: hex(sha512(hybridSigMessage(kp.publicKey, c.purpose, c.payload))),
    signature: hex(sig),
  };
});

const s0 = sigValid[1]!;
const s0sig = unhex(s0.signature);
const s0pk = unhex(s0.publicKey);
const s0payload = unhex(s0.payload);
const zeroed = (from: number, to: number): Uint8Array => {
  const c = Uint8Array.from(s0sig);
  c.fill(0, from, to);
  return c;
};

// Association swap: each half is a genuine signature by its own key over
// its own M'; recombined under a mixed public key it must fail.
const sigBForSame = unhex(hex(hybridSign(sigB.secretKey, s0.purpose, s0payload, { deterministic: true })));
const mixedPk = cat(s0pk.subarray(0, 32), sigB.publicKey.subarray(32));
const mixedSig = cat(s0sig.subarray(0, 64), sigBForSame.subarray(64));

// A cofactored-only Ed25519 signature: R carries an order-8 component.
// noble's default verify accepts it; the strict profile refuses it.
const L = ed25519.Point.Fn.ORDER;
const ext = ed25519.utils.getExtendedPublicKey(signerA.edSeed);
const torsion = ed25519.Point.fromBytes(unhex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"));
const mOf = hybridSigMessage(s0pk, s0.purpose, s0payload);
const r = 0x1234567890abcdefn;
const Rp = ed25519.Point.BASE.multiply(r).add(torsion);
const RpB = Rp.toBytes();
const leInt = (b: Uint8Array): bigint => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
const k = leInt(sha512(cat(RpB, s0pk.subarray(0, 32), mOf))) % L;
const Sx = (r + k * ext.scalar) % L;
const SB = new Uint8Array(32);
for (let i = 0, v = Sx; i < 32; i++, v >>= 8n) SB[i] = Number(v & 0xffn);
const cofactoredSig = cat(RpB, SB, s0sig.subarray(64));
if (!ed25519.verify(cat(RpB, SB), mOf, s0pk.subarray(0, 32), { zip215: false })) {
  throw new Error("cofactored-only vector did not verify under noble's cofactored check");
}

const edTorsionPk = ed25519.Point.fromBytes(s0pk.subarray(0, 32)).add(torsion).toBytes();
let nonCanonicalEd: Uint8Array | undefined;
let nonCanonicalFallback: Uint8Array | undefined;
for (let y = 0n; y < 19n && !nonCanonicalEd; y++) {
  for (const sign of [0, 0x80]) {
    const enc = new Uint8Array(32);
    for (let i = 0, v = y + (2n ** 255n - 19n); i < 32; i++, v >>= 8n) enc[i] = Number(v & 0xffn);
    enc[31] = enc[31]! | sign;
    try {
      const p = ed25519.Point.fromBytes(enc, true);
      nonCanonicalFallback ??= enc;
      if (!p.isSmallOrder() && p.isTorsionFree()) nonCanonicalEd = enc;
    } catch {
      // not on the curve
    }
  }
}
nonCanonicalEd ??= nonCanonicalFallback;
if (!nonCanonicalEd) throw new Error("no non-canonical Ed25519 encoding found");

const sigInvalid = [
  { name: "ed25519-zeroed", signature: zeroed(0, 64), expect: "bad-signature" },
  { name: "mldsa65-zeroed", signature: zeroed(64, 3373), expect: "bad-signature" },
  { name: "ed25519-missing", signature: s0sig.subarray(64), expect: "bad-signature" },
  { name: "mldsa65-missing", signature: s0sig.subarray(0, 64), expect: "bad-signature" },
  { name: "components-reordered", signature: cat(s0sig.subarray(64), s0sig.subarray(0, 64)), expect: "bad-signature" },
  { name: "trailing-byte", signature: cat(s0sig, Uint8Array.of(0)), expect: "bad-signature" },
  { name: "ed25519-tampered", signature: flip(s0sig, 40), expect: "bad-signature" },
  { name: "mldsa65-tampered", signature: flip(s0sig, 64 + 100), expect: "bad-signature" },
  { name: "swapped-key-association", publicKey: mixedPk, signature: mixedSig, expect: "bad-signature" },
  { name: "other-signers-key", publicKey: sigB.publicKey, expect: "bad-signature" },
  { name: "wrong-purpose", purpose: "flagship/release-root/v2", expect: "bad-signature" },
  { name: "wrong-payload", payload: flip(s0payload, 0), expect: "bad-signature" },
  { name: "ed25519-cofactored-only", signature: cofactoredSig, expect: "bad-signature" },
  { name: "bad-purpose", purpose: "pb/announce/v1", expect: "bad-purpose" },
  { name: "ed25519-identity-key", publicKey: cat(unhex("01" + "00".repeat(31)), s0pk.subarray(32)), expect: "bad-public-key" },
  { name: "ed25519-torsion-key", publicKey: cat(edTorsionPk, s0pk.subarray(32)), expect: "bad-public-key" },
  { name: "ed25519-non-canonical-small-order-key", publicKey: cat(nonCanonicalEd, s0pk.subarray(32)), expect: "bad-public-key" },
  { name: "public-key-short", publicKey: s0pk.subarray(0, 1983), expect: "bad-public-key" },
].map((c) => ({
  name: c.name,
  publicKey: hex(c.publicKey ?? s0pk),
  purpose: c.purpose ?? s0.purpose,
  payload: hex(c.payload ?? s0payload),
  signature: hex(c.signature ?? s0sig),
  expect: c.expect,
}));
const sigPayloadTooLarge = { publicKey: s0.publicKey, purpose: s0.purpose, payloadLen: 1_048_577, signature: s0.signature, expect: "payload-too-large" };

// Suite stripping: the Ed25519 half verifies only over M' (sanity), never
// over anything a classical-only verifier would be handed.
const classicalStrip = {
  publicKeyEd25519: hex(s0pk.subarray(0, 32)),
  signatureEd25519: hex(s0sig.subarray(0, 64)),
  signedMessage: hex(mOf),
  mustNotVerifyOver: [
    { name: "payload", message: s0.payload },
    { name: "purpose-pipe-payload", message: hex(utf8(`${s0.purpose}|${s0.payload}`)) },
    { name: "purpose-then-payload", message: hex(cat(utf8(s0.purpose), s0payload)) },
    { name: "message-without-suite-tag", message: hex(mOf.subarray(1 + sigTag.length)) },
  ],
  mldsaMustNotVerifyWithEmptyContext: true,
};
if (!ml_dsa65.verify(s0sig.subarray(64), mOf, s0pk.subarray(32), { context: utf8(sigTag) })) {
  throw new Error("ML-DSA self-check failed");
}

const out = {
  about:
    "Architecture-v2 hybrid suites (docs/architecture-v2/pq-suites.md). DRAFT, pending Q01 external cryptographic review; not enforced anywhere. Generated by the TypeScript port (tools/pq-hybrid-vectors.ts over @noble/post-quantum 0.7.1); the TypeScript and Rust tests re-derive every deterministic output byte for byte and must refuse every invalid case with exactly its `expect` code. X-Wing is draft-connolly-cfrg-xwing-kem-11; its own Appendix C KATs are in xwing-draft11-kats.json. ML-DSA signatures use the deterministic variant (rnd = 32 zero bytes).",
  keyIds,
  kem,
  envelope: { valid: envelopeValid, invalid: envelopeInvalid },
  seal: { valid: sealValid, invalid: sealInvalid, rejectPublicKeys: sealRejectPublicKeys, rejectInputs: sealRejectInputs },
  sig: { valid: sigValid, invalid: sigInvalid, payloadTooLarge: sigPayloadTooLarge, classicalStrip },
};
const text = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/pq-hybrid-vectors.ts`);
    process.exit(1);
  }
  console.log("pq-hybrid vectors are fresh");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
