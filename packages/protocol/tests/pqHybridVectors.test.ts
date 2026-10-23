// The TypeScript half of the architecture-v2 hybrid-suite vectors. The Rust
// half (rust/crates/flagship-crypto/tests/pq_hybrid_vectors.rs) reads the
// same files and must agree byte for byte and code for code.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { sha512 } from "@noble/hashes/sha512";
import {
  PqHybridError,
  TAG_HYBRID_SIG_ED25519_MLDSA65_V1,
  decodeEnvelopeHeader,
  encodeEnvelopeHeader,
  hybridOpen,
  hybridSeal,
  hybridSealKeygen,
  hybridSealWithRandomness,
  hybridSigKeygen,
  hybridSigMessage,
  hybridSign,
  hybridVerify,
  parseHybridSealPublicKey,
  pqKeyId,
  type EnvelopeHeaderV2,
} from "../src/pqHybrid.js";

const DIR = resolve(__dirname, "..", "test-vectors", "pq-hybrid");
const V = JSON.parse(readFileSync(resolve(DIR, "vectors.json"), "utf8"));
const KATS = JSON.parse(readFileSync(resolve(DIR, "xwing-draft11-kats.json"), "utf8"));

const h = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"));
const x = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof PqHybridError) return e.code;
    throw e;
  }
  return "ok";
}

function headerFrom(j: Record<string, unknown>): EnvelopeHeaderV2 {
  const out: EnvelopeHeaderV2 = {
    purpose: j.purpose as string,
    suite: j.suite as number,
    senderKeyId: h(j.senderKeyId as string),
    issuedAt: j.issuedAt as number,
    bodyLen: j.bodyLen as number,
  };
  if (j.recipientKeyId) out.recipientKeyId = h(j.recipientKeyId as string);
  if (j.installationId) out.installationId = h(j.installationId as string);
  if (j.authorityGeneration !== undefined) out.authorityGeneration = j.authorityGeneration as number;
  if (j.sessionNonce) out.sessionNonce = h(j.sessionNonce as string);
  if (j.policyDigest) out.policyDigest = h(j.policyDigest as string);
  if (j.expiresAt !== undefined) out.expiresAt = j.expiresAt as number;
  return out;
}

const sealOptions = (o: Record<string, unknown>) => {
  const { senderKeyId, installationId, sessionNonce, policyDigest, ...rest } = o;
  return {
    ...(rest as { purpose: string; issuedAt: number }),
    senderKeyId: h(senderKeyId as string),
    ...(installationId ? { installationId: h(installationId as string) } : {}),
    ...(sessionNonce ? { sessionNonce: h(sessionNonce as string) } : {}),
    ...(policyDigest ? { policyDigest: h(policyDigest as string) } : {}),
  };
};

describe("X-Wing draft-11 Appendix C known answers (noble)", () => {
  for (const [i, v] of (KATS.vectors as Record<string, string>[]).entries()) {
    it(`vector ${i}`, () => {
      const { secretKey, publicKey } = ml_kem768_x25519.keygen(h(v.seed!));
      expect(x(secretKey)).toBe(v.sk);
      expect(x(publicKey)).toBe(v.pk);
      const e = ml_kem768_x25519.encapsulate(publicKey, h(v.eseed!));
      expect(x(e.cipherText)).toBe(v.ct);
      expect(x(e.sharedSecret)).toBe(v.ss);
      expect(x(ml_kem768_x25519.decapsulate(h(v.ct!), secretKey))).toBe(v.ss);
    });
  }
});

describe("pq-hybrid shared vectors (TypeScript)", () => {
  it("key ids", () => {
    for (const k of V.keyIds) expect(x(pqKeyId(k.suite, h(k.publicKey)))).toBe(k.keyId);
  });

  it("raw X-Wing cases", () => {
    for (const k of V.kem) {
      const { publicKey, secretKey } = ml_kem768_x25519.keygen(h(k.seed));
      expect(x(publicKey)).toBe(k.publicKey);
      const e = ml_kem768_x25519.encapsulate(publicKey, h(k.eseed));
      expect(x(e.cipherText)).toBe(k.enc);
      expect(x(e.sharedSecret)).toBe(k.sharedSecret);
      expect(x(ml_kem768_x25519.decapsulate(e.cipherText, secretKey))).toBe(k.sharedSecret);
    }
  });

  it("envelope headers encode canonically and decode back", () => {
    for (const c of V.envelope.valid) {
      const hdr = headerFrom(c.header);
      expect(x(encodeEnvelopeHeader(hdr))).toBe(c.hex);
      const d = decodeEnvelopeHeader(h(c.hex));
      expect(d.length).toBe(c.hex.length / 2);
      expect(x(encodeEnvelopeHeader(d.header))).toBe(c.hex);
    }
  });

  it.each(V.envelope.invalid.map((c: { name: string }) => [c.name, c]))("envelope refuses %s", (_n, c) => {
    const cc = c as { hex: string; expect: string };
    expect(code(() => decodeEnvelopeHeader(h(cc.hex)))).toBe(cc.expect);
  });

  it("seal: deterministic outputs and round trip", () => {
    for (const c of V.seal.valid) {
      const kp = hybridSealKeygen(h(c.recipientSeed));
      expect(x(kp.publicKey)).toBe(c.recipientPublicKey);
      const ctx = (c.context as string[]).map(h);
      const sealed = hybridSealWithRandomness(kp.publicKey, sealOptions(c.options), ctx, h(c.plaintext), h(c.eseed));
      expect(x(sealed)).toBe(c.sealed);
      const opened = hybridOpen(kp.secretKey, c.options.purpose, ctx, h(c.sealed));
      expect(x(opened.plaintext)).toBe(c.plaintext);
      expect(x(opened.header.senderKeyId)).toBe(c.options.senderKeyId);
    }
  });

  it("seal: randomized path opens", () => {
    const c = V.seal.valid[0];
    const kp = hybridSealKeygen(h(c.recipientSeed));
    const ctx = (c.context as string[]).map(h);
    const a = hybridSeal(kp.publicKey, sealOptions(c.options), ctx, h(c.plaintext));
    const b = hybridSeal(kp.publicKey, sealOptions(c.options), ctx, h(c.plaintext));
    expect(x(a)).not.toBe(x(b));
    expect(x(hybridOpen(kp.secretKey, c.options.purpose, ctx, a).plaintext)).toBe(c.plaintext);
  });

  it.each(V.seal.invalid.map((c: { name: string }) => [c.name, c]))("open refuses %s", (_n, c) => {
    const cc = c as { recipientSeed: string; expectedPurpose: string; context: string[]; sealed: string; expect: string };
    expect(code(() => hybridOpen(h(cc.recipientSeed), cc.expectedPurpose, cc.context.map(h), h(cc.sealed)))).toBe(cc.expect);
  });

  it("seal refuses bad recipient keys and inputs", () => {
    for (const c of V.seal.rejectPublicKeys) expect(code(() => parseHybridSealPublicKey(h(c.publicKey))), c.name).toBe(c.expect);
    const base = V.seal.valid[0];
    for (const c of V.seal.rejectInputs) {
      const opts = { ...sealOptions(base.options), purpose: c.purpose };
      const ctx = Array.from({ length: c.contextFields }, () => new Uint8Array(0));
      const pt = new Uint8Array(c.plaintextLen);
      expect(code(() => hybridSealWithRandomness(h(base.recipientPublicKey), opts, ctx, pt, h(base.eseed))), c.name).toBe(c.expect);
    }
  });

  it("sig: deterministic signatures reproduce and verify", () => {
    for (const c of V.sig.valid) {
      const kp = hybridSigKeygen(h(c.edSeed), h(c.mldsaSeed));
      expect(x(kp.publicKey)).toBe(c.publicKey);
      expect(x(pqKeyId(2, kp.publicKey))).toBe(c.keyId);
      expect(x(sha512(hybridSigMessage(kp.publicKey, c.purpose, h(c.payload))))).toBe(c.messageSha512);
      expect(x(hybridSign(kp.secretKey, c.purpose, h(c.payload), { deterministic: true }))).toBe(c.signature);
      expect(code(() => hybridVerify(kp.publicKey, c.purpose, h(c.payload), h(c.signature)))).toBe("ok");
      const hedged = hybridSign(kp.secretKey, c.purpose, h(c.payload));
      expect(code(() => hybridVerify(kp.publicKey, c.purpose, h(c.payload), hedged))).toBe("ok");
    }
  });

  it.each(V.sig.invalid.map((c: { name: string }) => [c.name, c]))("verify refuses %s", (_n, c) => {
    const cc = c as { publicKey: string; purpose: string; payload: string; signature: string; expect: string };
    expect(code(() => hybridVerify(h(cc.publicKey), cc.purpose, h(cc.payload), h(cc.signature)))).toBe(cc.expect);
  });

  it("verify refuses an oversize payload", () => {
    const c = V.sig.payloadTooLarge;
    expect(code(() => hybridVerify(h(c.publicKey), c.purpose, new Uint8Array(c.payloadLen), h(c.signature)))).toBe(c.expect);
  });

  it("the cofactored-only vector really is accepted by a plain cofactored verifier", () => {
    const c = V.sig.invalid.find((v: { name: string }) => v.name === "ed25519-cofactored-only");
    const pk = h(c.publicKey);
    const m = hybridSigMessage(pk, c.purpose, h(c.payload));
    expect(ed25519.verify(h(c.signature).subarray(0, 64), m, pk.subarray(0, 32), { zip215: false })).toBe(true);
  });

  it("a stripped component never verifies as a classical-only signature", () => {
    const s = V.sig.classicalStrip;
    const pk = h(s.publicKeyEd25519);
    const sig = h(s.signatureEd25519);
    expect(ed25519.verify(sig, h(s.signedMessage), pk, { zip215: false })).toBe(true);
    for (const m of s.mustNotVerifyOver) {
      expect(ed25519.verify(sig, h(m.message), pk, { zip215: false }), m.name).toBe(false);
    }
    const c = V.sig.valid[1];
    const full = h(c.signature);
    const mlPk = h(c.publicKey).subarray(32);
    const m = hybridSigMessage(h(c.publicKey), c.purpose, h(c.payload));
    expect(ml_dsa65.verify(full.subarray(64), m, mlPk, { context: utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1) })).toBe(true);
    expect(ml_dsa65.verify(full.subarray(64), m, mlPk)).toBe(false);
    expect(ml_dsa65.verify(full.subarray(64), h(c.payload), mlPk, { context: utf8(TAG_HYBRID_SIG_ED25519_MLDSA65_V1) })).toBe(false);
  });
});
