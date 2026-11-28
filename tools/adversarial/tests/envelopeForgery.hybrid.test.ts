/**
 * V01 adversarial suite, ENV slice, part 2: the signed families the generic harness
 * (envelopeForgery.test.ts) cannot drive, and the attacks that only make sense for them.
 *
 * Boundary: the hybrid (Ed25519 AND ML-DSA-65) verifiers that strict mode rests on, the PQ companions
 * of releases / box artifacts / CA leases, CA-signed artifacts, per-type phone orders, the server
 * order, the dual-signed RCK rotation and the HMAC proofs. A verifier here that accepts a spliced,
 * stripped, relabelled or cross-purpose signature lets a classical-only (or quantum) forger act.
 *
 *   AT-ENV-20  hybrid primitive: splice, strip, purpose swap, key-half substitution
 *   AT-ENV-21  pq-key-binding/v1: wrong role/subject/key, pinned ML-DSA changed, classical-only signature
 *   AT-ENV-22  the critical-signature gate: suite stripping, look-alike bindings, purpose confusion
 *   AT-ENV-23  release-endorsement/v2: halves spliced from two releases; companion relabelled across families
 *   AT-ENV-24  box-artifact/v2 companion: another family's hybrid signature, another signer's binding
 *   AT-ENV-25  CA-signed time: signed-time/v1 and auth-time/v1 cannot stand in for each other
 *   AT-ENV-26  CA-signed account-key attestation and service blessing: forged / unauthorized / relabelled
 *   AT-ENV-27  phone orders, every type: flip, other key, and one type's signature on another type
 *   AT-ENV-28  server-order/v1: hex signature forms, reordered stks, other key
 *   AT-ENV-29  rotate-rck/v1: either of the two signatures missing or swapped
 *   AT-ENV-30  MAC proofs (gossip/v2, enrollment-proof/v1, server-code-seen/v1): wrong key, truncated, case
 *   AT-ENV-31  box-claim-receipt/v1: flipped, spliced, relabelled, re-signed by another box key, any field changed
 *   AT-ENV-32  org-server-code/v2: any field changed, a separator shifted, a flipped approval, approval of another code
 *   AT-ENV-33  org-server-register/v1: flipped, another box key, any field changed, a separator shifted
 *   AT-ENV-34  org-seat-kem/v1 and org-box-kem/v1: flipped, another signer, any field changed
 *   AT-ENV-35  org-key-ring/v1: any ring field changed, a flipped approval, a rolled-back version
 *   AT-ENV-36  org-audit-export/v1 and the org-log/v1 chain: statement changed, log rewritten, separator shifted in a log entry
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import * as P from "../../../packages/protocol/src/index.js";
import { hybridSign, hybridSigKeygen, hybridVerify } from "../../../packages/protocol/src/pqHybrid.js";
import { signBoxArtifactPq, verifyBoxArtifactPq } from "../../../packages/protocol/src/boxArtifactPq.js";
import { fromHex, newKey, toHex } from "./support/envelopeDriver.js";

const VECTORS = join(import.meta.dirname, "../../../packages/protocol/test-vectors");
const seed = (n: number) => new Uint8Array(32).fill(n);
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

// ---------------------------------------------------------------- hybrid primitive

describe("AT-ENV-20 hybrid-sig/ed25519-mldsa65/v1 primitive", () => {
  const k1 = hybridSigKeygen(seed(1), seed(2));
  const k2 = hybridSigKeygen(seed(3), seed(4));
  const PURPOSE = "flagship/server-order/v1";
  const m1 = new TextEncoder().encode(`${PURPOSE}|alice|a`);
  const m2 = new TextEncoder().encode(`${PURPOSE}|alice|b`);
  const s1 = hybridSign(k1.secretKey, PURPOSE, m1, { deterministic: true });
  const s2 = hybridSign(k1.secretKey, PURPOSE, m2, { deterministic: true });

  it("AT-ENV-20a control: a hybrid signature verifies", () => {
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, s1))).toBe(false);
  });

  it("AT-ENV-20b the Ed25519 half of one message spliced onto the ML-DSA half of another is refused (catches: a verifier that accepts either half)", () => {
    const spliced = new Uint8Array(s1);
    spliced.set(s2.subarray(0, 64), 0);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, spliced))).toBe(true);
    const spliced2 = new Uint8Array(s2.subarray(0, 64).length + s1.length - 64);
    spliced2.set(s1.subarray(0, 64), 0);
    spliced2.set(s2.subarray(64), 64);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, spliced2))).toBe(true);
  });

  it("AT-ENV-20c either half zeroed, or the signature cut to its Ed25519 half, is refused (catches: suite stripping inside the signature)", () => {
    const zEd = new Uint8Array(s1);
    zEd.fill(0, 0, 64);
    const zMl = new Uint8Array(s1);
    zMl.fill(0, 64);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, zEd))).toBe(true);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, zMl))).toBe(true);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, s1.subarray(0, 64)))).toBe(true);
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, s1.subarray(64)))).toBe(true);
  });

  it("AT-ENV-20d a signature made for one purpose does not verify under another (catches: cross-protocol reuse of hybrid signatures)", () => {
    expect(throws(() => hybridVerify(k1.publicKey, "flagship/release-endorsement/v2", m1, s1))).toBe(true);
  });

  it("AT-ENV-20e a public key built from one key's Ed25519 half and another's ML-DSA half verifies nothing (catches: key-half substitution)", () => {
    const mixed = new Uint8Array(k1.publicKey);
    mixed.set(k2.publicKey.subarray(32), 32);
    expect(throws(() => hybridVerify(mixed, PURPOSE, m1, s1))).toBe(true);
    // and a forger holding only the classical key of k1 cannot produce one for the mixed key
    const forged = hybridSign(new Uint8Array([...seed(1), ...seed(4)]), PURPOSE, m1, { deterministic: true });
    expect(throws(() => hybridVerify(k1.publicKey, PURPOSE, m1, forged))).toBe(true);
  });
});

// ---------------------------------------------------------------- pq-key-binding + gate

function makeBinding(role: P.PqBindingRole, subjectId: string, edSeed: number, mlSeed: number, issuedAt = 1_760_000_000_000) {
  const k = hybridSigKeygen(seed(edSeed), seed(mlSeed));
  const statement: P.PqKeyBindingStatement = {
    role,
    subjectId,
    ed25519PubHex: toHex(k.publicKey.subarray(0, 32)),
    mldsaPubHex: toHex(k.publicKey.subarray(32)),
    issuedAt,
  };
  const wire = P.signPqKeyBinding(statement, (msg) => hybridSign(k.secretKey, P.TAG_PQ_KEY_BINDING, msg, { deterministic: true }));
  return { k, wire, statement };
}

describe("AT-ENV-21 pq-key-binding/v1", () => {
  const NOW = 1_760_000_100_000;
  const { wire, statement } = makeBinding("account-irk", "alice", 5, 6);
  const expect0: P.PqBindingExpectation = { role: "account-irk", subjectId: "alice", ed25519PubHex: statement.ed25519PubHex, now: NOW };

  it("AT-ENV-21a control: the binding verifies for its role, subject and key", () => {
    expect(P.verifyPqKeyBinding(wire, expect0).keyIdHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AT-ENV-21b the same binding presented for another role, subject or Ed25519 key is refused (catches: a box-stk binding accepted as an account-irk or admin-root binding)", () => {
    expect(throws(() => P.verifyPqKeyBinding(wire, { ...expect0, role: "admin-root" }))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding(wire, { ...expect0, subjectId: "bob" }))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding(wire, { ...expect0, ed25519PubHex: toHex(ed25519.getPublicKey(seed(9))) }))).toBe(true);
  });

  it("AT-ENV-21c a binding that replaces the pinned ML-DSA key is refused (catches: PQ-key substitution behind a trusted classical key)", () => {
    const other = makeBinding("account-irk", "alice", 5, 7);
    expect(throws(() => P.verifyPqKeyBinding(other.wire, { ...expect0, mldsaPubHex: statement.mldsaPubHex }))).toBe(true);
  });

  it("AT-ENV-21d a binding whose signature is only the Ed25519 half, or is edited after signing, is refused (catches: a classical-only forger binding their own ML-DSA key)", () => {
    expect(throws(() => P.verifyPqKeyBinding({ ...wire, signature: wire.signature.slice(0, 128) }, expect0))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire, issuedAt: wire.issuedAt + 1 }, expect0))).toBe(true);
    // A classical-only attacker (holds the Ed25519 seed, not the ML-DSA seed) signs a binding to THEIR ML-DSA key:
    const forger = hybridSigKeygen(seed(5), seed(99));
    const forgedStatement = { ...statement, mldsaPubHex: toHex(forger.publicKey.subarray(32)) };
    const forged = P.signPqKeyBinding(forgedStatement, (msg) => hybridSign(forger.secretKey, P.TAG_PQ_KEY_BINDING, msg, { deterministic: true }));
    // With no ML-DSA pin it verifies (first binding is trust-on-first-use: the verifier must pin it).
    expect(throws(() => P.verifyPqKeyBinding(forged, expect0))).toBe(false);
    // With the honest pin it is refused.
    expect(throws(() => P.verifyPqKeyBinding(forged, { ...expect0, mldsaPubHex: statement.mldsaPubHex }))).toBe(true);
  });

  it("AT-ENV-21e a binding dated in the future or before the verifier's floor is refused (catches: replay of an old binding after rotation)", () => {
    const future = makeBinding("account-irk", "alice", 5, 6, NOW + 3_600_000);
    expect(throws(() => P.verifyPqKeyBinding(future.wire, expect0))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding(wire, { ...expect0, minIssuedAt: statement.issuedAt + 1 }))).toBe(true);
  });
});

describe("AT-ENV-21 pq-key-binding/v2 (the compact release-key binding a YubiKey can sign)", () => {
  const NOW = 1_760_000_100_000;
  const k = hybridSigKeygen(seed(21), seed(22));
  const other = hybridSigKeygen(seed(23), seed(24));
  const st: P.PqKeyBindingStatement = {
    role: "release-key",
    subjectId: "flagship-release",
    ed25519PubHex: toHex(k.publicKey.subarray(0, 32)),
    mldsaPubHex: toHex(k.publicKey.subarray(32)),
    issuedAt: 1_760_000_000_000,
  };
  const sign2 = (statement: P.PqKeyBindingStatement, key = k) =>
    toHex(hybridSign(key.secretKey, P.TAG_PQ_KEY_BINDING_V2, P.canonicalPqKeyBindingV2(statement), { deterministic: true }));
  const wire2 = { v: 2, ...st, signature: sign2(st) };
  const expect2: P.PqBindingExpectation = { role: "release-key", subjectId: "flagship-release", ed25519PubHex: st.ed25519PubHex, now: NOW };

  it("AT-ENV-21f control: the compact binding verifies", () => {
    expect(P.verifyPqKeyBinding(wire2, expect2).keyIdHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AT-ENV-21g a v1 signature is not a v2 binding, and a v2 signature is not a v1 binding (catches: version confusion between the two statements)", () => {
    const v1sig = toHex(hybridSign(k.secretKey, P.TAG_PQ_KEY_BINDING, P.canonicalPqKeyBinding(st), { deterministic: true }));
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, signature: v1sig }, expect2))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, v: 1 }, expect2))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, v: 3 }, expect2))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, v: undefined }, expect2))).toBe(true);
  });

  it("AT-ENV-21h the compact form leaves the ML-DSA key out of the statement but not out of the signed message: another ML-DSA key is refused (catches: PQ-key substitution behind the trusted Ed25519 key)", () => {
    const swapped = { ...wire2, mldsaPubHex: toHex(other.publicKey.subarray(32)) };
    expect(throws(() => P.verifyPqKeyBinding(swapped, expect2))).toBe(true);
    // Even re-signed with the new ML-DSA seed under the genuine Ed25519 half, the Ed25519 half no longer matches.
    const forgerKey = hybridSigKeygen(seed(21), seed(24));
    const forgedSt = { ...st, mldsaPubHex: toHex(forgerKey.publicKey.subarray(32)) };
    const forged = { v: 2, ...forgedSt, signature: toHex(hybridSign(forgerKey.secretKey, P.TAG_PQ_KEY_BINDING_V2, P.canonicalPqKeyBindingV2(forgedSt), { deterministic: true })) };
    expect(throws(() => P.verifyPqKeyBinding(forged, { ...expect2, mldsaPubHex: st.mldsaPubHex }))).toBe(true);
    // A classical-only signature, an edited date or an edited subject are refused too.
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, signature: wire2.signature.slice(0, 128) }, expect2))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, issuedAt: wire2.issuedAt + 1 }, expect2))).toBe(true);
    expect(throws(() => P.verifyPqKeyBinding({ ...wire2, subjectId: "flagship-ca-track" }, { ...expect2, subjectId: "flagship-ca-track" }))).toBe(true);
  });

  it("AT-ENV-21i only the release-key role may use the compact form (catches: a device or box binding downgraded to the shorter statement)", () => {
    for (const role of ["account-irk", "admin-root", "device", "box-stk", "boot-key"] as const) {
      const w = makeBinding(role, "x", 31, 32).wire;
      expect(throws(() => P.verifyPqKeyBinding({ ...w, v: 2 }, { role, subjectId: "x", ed25519PubHex: w.ed25519PubHex, now: NOW }))).toBe(true);
      expect(throws(() => P.canonicalPqKeyBindingV2({ ...w, role }))).toBe(true);
    }
  });

  it("AT-ENV-21j every message the YubiKey signs for a compact binding is far below its PIV limit (catches: the 6,095-byte v1 statement coming back)", () => {
    const m = P.hybridSigMessage(k.publicKey, P.TAG_PQ_KEY_BINDING_V2, P.canonicalPqKeyBindingV2(st));
    expect(m.length).toBeLessThan(2_500);
  });
});

describe("AT-ENV-22 the critical-signature gate (verifyCriticalSignature)", () => {
  const NOW = 1_760_000_100_000;
  const b = makeBinding("admin-root", "alice", 11, 12);
  const binding = P.verifyPqKeyBinding(b.wire, { role: "admin-root", subjectId: "alice", ed25519PubHex: b.statement.ed25519PubHex, now: NOW });
  const PURPOSE = "flagship/server-order/v1";
  const msg = new TextEncoder().encode(`${PURPOSE}|alice|x`);
  const hybridHex = toHex(hybridSign(b.k.secretKey, PURPOSE, msg, { deterministic: true }));
  const edHex = toHex(ed25519.sign(msg, seed(11)));
  const scope: P.PolicyScope = { kind: "installation", id: "home.alice.flagship.services" };
  const strict: P.PolicyState = { scope, profile: "strict", rollout: "enforced", generation: 2, headDigest: "1".repeat(64), enforcedEver: true };
  const compat = P.legacyPolicyState(scope);
  const base = { message: msg, expectedPurpose: PURPOSE, signerEd25519PubHex: b.statement.ed25519PubHex, binding };
  const ok = (input: P.CriticalSignatureInput) => !throws(() => P.verifyCriticalSignature(input));

  it("AT-ENV-22a control: hybrid passes strict, classical passes compatibility", () => {
    expect(ok({ ...base, envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hybridHex }, policy: strict })).toBe(true);
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: edHex }, binding: null, policy: compat })).toBe(true);
  });

  it("AT-ENV-22b strict refuses a valid Ed25519 signature, with or without a binding (catches: suite stripping / downgrade to classical)", () => {
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: edHex }, policy: strict })).toBe(false);
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: edHex }, binding: null, policy: strict })).toBe(false);
    // the hybrid signature's Ed25519 half relabelled as an ed25519/v1 envelope
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: hybridHex.slice(0, 128) }, policy: strict })).toBe(false);
  });

  it("AT-ENV-22c a look-alike binding (same fields, not produced by verifyPqKeyBinding) is refused (catches: a caller fabricating a verified binding)", () => {
    const lookalike = { ...binding };
    expect(ok({ ...base, binding: lookalike as P.VerifiedPqKeyBinding, envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hybridHex }, policy: strict })).toBe(false);
  });

  it("AT-ENV-22d another signer's binding, a mismatched purpose, a relabelled suite and a spliced hybrid signature are refused (catches: binding/purpose confusion)", () => {
    const other = makeBinding("admin-root", "alice", 13, 14);
    const otherB = P.verifyPqKeyBinding(other.wire, { role: "admin-root", subjectId: "alice", ed25519PubHex: other.statement.ed25519PubHex, now: NOW });
    expect(ok({ ...base, binding: otherB, envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hybridHex }, policy: strict })).toBe(false);
    expect(ok({ ...base, expectedPurpose: "flagship/server-update/v1", envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: hybridHex }, policy: strict })).toBe(false);
    expect(ok({ ...base, envelope: { suite: "hybrid-ed25519-mldsa65/v2" as P.SignatureSuite, signature: hybridHex }, policy: strict })).toBe(false);
    const otherMsg = new TextEncoder().encode(`${PURPOSE}|alice|y`);
    const s2 = hybridSign(b.k.secretKey, PURPOSE, otherMsg, { deterministic: true });
    const spliced = fromHex(hybridHex);
    spliced.set(s2.subarray(64), 64);
    expect(ok({ ...base, envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: toHex(spliced) }, policy: strict })).toBe(false);
  });

  it("AT-ENV-22e a policy that is strict but not yet enforced does not demand hybrid, and an enforced strict one cannot be talked out of it by the envelope (catches: rollout-state confusion)", () => {
    const prepared: P.PolicyState = { ...strict, rollout: "prepared" };
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: edHex }, binding: null, policy: prepared })).toBe(true);
    expect(ok({ ...base, envelope: { suite: "ed25519/v1", signature: edHex }, binding: null, policy: { ...strict, rollout: "retired" } })).toBe(false);
  });
});

// ---------------------------------------------------------------- release endorsement v2

describe("AT-ENV-23 release-endorsement/v2 companions", () => {
  type RV = {
    now: number;
    keys: Record<string, { ed25519PubHex: string; mldsaPubHex: string; keyId: string; edSeedHex: string; mldsaSeedHex: string }>;
    pins: Record<string, P.ReleasePqPin>;
    bindings: Record<string, unknown>;
    endorsements: Record<string, unknown>;
    companions: Record<string, { signature: string } & Record<string, unknown>>;
  };
  const V = JSON.parse(readFileSync(join(VECTORS, "release-endorsement-v2/vectors.json"), "utf8")) as RV;
  const pin = V.pins.main!;
  const bindings = P.verifyReleasePqBindings([V.bindings.release], pin, V.now).bindings;
  const k = V.keys.release!;
  const verify = (e: unknown, c: unknown) => !throws(() => P.verifyReleaseEndorsementPq(e as never, c as never, { pin, bindings }));

  it("AT-ENV-23a control: the vector companion verifies", () => {
    expect(verify(V.endorsements.C, V.companions.C)).toBe(true);
  });

  it("AT-ENV-23b a companion whose ML-DSA half comes from another release's companion is refused (catches: half-splicing across releases)", async () => {
    const d = await P.signReleaseEndorsementPq(V.endorsements.D as never, k, async (m) => ed25519.sign(m, fromHex(k.edSeedHex)), fromHex(k.mldsaSeedHex), { deterministic: true });
    expect(verify(V.endorsements.D, d)).toBe(true);
    const c = V.companions.C!;
    const spliced = c.signature.slice(0, 128) + (d as { signature: string }).signature.slice(128);
    expect(verify(V.endorsements.C, { ...c, signature: spliced })).toBe(false);
    const spliced2 = (d as { signature: string }).signature.slice(0, 128) + c.signature.slice(128);
    expect(verify(V.endorsements.C, { ...c, signature: spliced2 })).toBe(false);
  });

  it("AT-ENV-23c a hybrid signature made by the same release key for another purpose (a box-artifact companion) is refused as a release companion (catches: cross-family reuse of the release key's PQ half)", () => {
    const hk = hybridSigKeygen(fromHex(k.edSeedHex), fromHex(k.mldsaSeedHex));
    const box = signBoxArtifactPq(new TextEncoder().encode("flagship/box-artifact/v1|x"), hk.secretKey, hk.publicKey);
    const c = V.companions.C!;
    expect(verify(V.endorsements.C, { ...c, signature: box.signatureHex })).toBe(false);
  });
});

// ---------------------------------------------------------------- box artifact v2

describe("AT-ENV-24 box-artifact/v2 companion", () => {
  const NOW = 1_760_000_100_000;
  const rel = makeBinding("release-key", P.BOX_ARTIFACT_PQ_BINDING_SUBJECT, 21, 22);
  const relB = P.verifyPqKeyBinding(rel.wire, { role: "release-key", subjectId: P.BOX_ARTIFACT_PQ_BINDING_SUBJECT, ed25519PubHex: rel.statement.ed25519PubHex, now: NOW });
  const map = new Map([[relB.ed25519PubHex, relB]]);
  const v1 = new TextEncoder().encode("flagship/box-artifact/v1|0123|amd64");
  const comp = signBoxArtifactPq(v1, rel.k.secretKey, rel.k.publicKey);

  it("AT-ENV-24a control: the companion verifies for its signer", () => {
    expect(verifyBoxArtifactPq(v1, relB.ed25519PubHex, comp, map)).toBe(true);
  });

  it("AT-ENV-24b the companion of one manifest is refused on another, and under another signer (catches: companion replay across artifacts)", () => {
    const v1b = new TextEncoder().encode("flagship/box-artifact/v1|0123|arm64");
    expect(verifyBoxArtifactPq(v1b, relB.ed25519PubHex, comp, map)).toBe(false);
    expect(verifyBoxArtifactPq(v1, toHex(ed25519.getPublicKey(seed(30))), comp, map)).toBe(false);
  });

  it("AT-ENV-24c a hybrid signature by the same key under another purpose, a stripped half or another key id is refused (catches: cross-purpose reuse and suite stripping)", () => {
    const other = toHex(hybridSign(rel.k.secretKey, "flagship/release-endorsement/v2", v1, { deterministic: true }));
    expect(verifyBoxArtifactPq(v1, relB.ed25519PubHex, { ...comp, signatureHex: other }, map)).toBe(false);
    expect(verifyBoxArtifactPq(v1, relB.ed25519PubHex, { ...comp, signatureHex: comp.signatureHex.slice(0, 128) }, map)).toBe(false);
    expect(verifyBoxArtifactPq(v1, relB.ed25519PubHex, { ...comp, keyId: "0".repeat(64) }, map)).toBe(false);
    expect(verifyBoxArtifactPq(v1, relB.ed25519PubHex, undefined, map)).toBe(false);
  });
});

// ---------------------------------------------------------------- CA-signed artifacts

const PIN = "ab".repeat(32);
const caKp = { privateKey: seed(40), publicKey: ed25519.getPublicKey(seed(40)) };
const chainOf = (keys: string[]) => ({ authorizedCaKeys: () => keys }) as unknown as P.CaTrustChain;
const NONCE = "0123456789abcdef".repeat(4);
const NONCE_A = "0123456789abcdef".repeat(2);

describe("AT-ENV-25 CA-signed time (signed-time/v1, auth-time/v1)", () => {
  const chain = chainOf([toHex(caKp.publicKey)]);

  it("AT-ENV-25a control: each verifies under an authorized CA key", () => {
    expect(P.verifyAuthTime(P.signAuthTime(NONCE_A, 1_760_000_000_000, caKp), NONCE_A, chain, PIN).ok).toBe(true);
    expect(P.verifySignedTime(P.signSignedTime(NONCE, 1_760_000_000_000, caKp.privateKey), NONCE, chain, PIN).ok).toBe(true);
  });

  it("AT-ENV-25b an auth-time signature is refused as a signed-time answer and vice versa (catches: cross-protocol reuse of the CA time signature)", () => {
    const a = P.signAuthTime(NONCE_A, 1_760_000_000_000, caKp);
    const s = P.signSignedTime(NONCE, 1_760_000_000_000, caKp.privateKey);
    expect(P.verifySignedTime({ ...s, signature: a.signature }, NONCE, chain, PIN).ok).toBe(false);
    expect(P.verifyAuthTime({ ...a, signature: s.signature }, NONCE_A, chain, PIN).ok).toBe(false);
  });

  it("AT-ENV-25c a self-signed answer (key not in the CA chain), another nonce or a moved time is refused (catches: a forged clock)", () => {
    const rogue = { privateKey: seed(41), publicKey: ed25519.getPublicKey(seed(41)) };
    expect(P.verifySignedTime(P.signSignedTime(NONCE, 1_760_000_000_000, rogue.privateKey), NONCE, chain, PIN).ok).toBe(false);
    const s = P.signSignedTime(NONCE, 1_760_000_000_000, caKp.privateKey);
    expect(P.verifySignedTime(s, "f".repeat(32), chain, PIN).ok).toBe(false);
    expect(P.verifySignedTime({ ...s, timeMs: s.timeMs + 1 }, NONCE, chain, PIN).ok).toBe(false);
    expect(P.verifySignedTime(s, NONCE, null, PIN).ok).toBe(false);
  });
});

describe("AT-ENV-26 CA-signed account-key attestation and service blessing", () => {
  const NOW = 1_760_000_000_000;
  const chain = chainOf([toHex(caKp.publicKey)]);
  const body: P.AccountKeyAttestationBody = { keyKind: "share", keyPubHex: "07".repeat(32), issuedAt: NOW - 1000, expiresAt: NOW + 86_400_000 };

  it("AT-ENV-26a control: the attestation verifies", () => {
    expect(P.verifyCaSignedAccountKeyAttestation(P.signAccountKeyAttestation(body, caKp), chain, NOW, PIN).ok).toBe(true);
  });

  it("AT-ENV-26b an attestation relabelled from a per-share key to a stable admin-root, re-keyed, or signed by a non-CA key is refused (catches: an attestation reused as an account-key attestation)", () => {
    const shareAtt = P.signAccountKeyAttestation(body, caKp);
    expect(P.verifyCaSignedAccountKeyAttestation({ ...shareAtt, keyKind: "admin-root" as never }, chain, NOW, PIN).ok).toBe(false);
    const a = P.signAccountKeyAttestation(body, caKp);
    expect(P.verifyCaSignedAccountKeyAttestation({ ...a, keyPubHex: "08".repeat(32) }, chain, NOW, PIN).ok).toBe(false);
    const rogue = { privateKey: seed(42), publicKey: ed25519.getPublicKey(seed(42)) };
    expect(P.verifyCaSignedAccountKeyAttestation(P.signAccountKeyAttestation(body, rogue), chain, NOW, PIN).ok).toBe(false);
  });

  it("AT-ENV-26c a service blessing's signature is refused as an account-key attestation (catches: CA signature reuse across artifact kinds)", () => {
    const bl = P.signServiceBlessing({ hubKeyPub: "07".repeat(32), hubHost: "flagship.services", nonce: NONCE, issuedAt: NOW - 1000, expiresAt: NOW + 86_400_000 }, caKp);
    expect(P.verifyCaSignedServiceBlessing(bl, chain, NOW, PIN).ok).toBe(true);
    const a = P.signAccountKeyAttestation(body, caKp);
    expect(P.verifyCaSignedAccountKeyAttestation({ ...a, signature: bl.signatures[0]!.sig }, chain, NOW, PIN).ok).toBe(false);
    expect(P.verifyCaSignedServiceBlessing({ ...bl, hubHost: "evil.example" }, chain, NOW, PIN).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- phone orders, server order, rotate-rck

describe("AT-ENV-27 phone orders, every type (flagship/order/<type>/vN)", () => {
  const T = 1_760_000_000_000;
  const sid = "home.alice.flagship.services";
  const orders: P.PhoneOrder[] = [
    { type: "noop", serverId: sid, issuedAt: T },
    { type: "set-backup-policy", serverId: sid, enabled: true, issuedAt: T },
    { type: "shut-down", serverId: sid, issuedAt: T },
    { type: "power-off", serverId: sid, mode: "restart", issuedAt: T },
    { type: "revoke-self", serverId: sid, reason: "lost", issuedAt: T },
    { type: "rotate-server-identity", serverId: sid, newIdentityPubKey: new Uint8Array(32).fill(7), issuedAt: T },
    { type: "deliver-bak", serverId: sid, bakPubKey: new Uint8Array(32).fill(8), issuedAt: T },
    { type: "browser-input-response", serverId: sid, tabId: "t1", inputKind: "otp", value: "123456", screenshotRef: "s1", issuedAt: T },
    { type: "add-subscriber", serverId: sid, serviceId: "alice--notes", fqdn: "notes.alice.flagship.services", issuedAt: T },
    { type: "remove-subscriber", serverId: sid, serviceId: "alice--notes", fqdn: "notes.alice.flagship.services", issuedAt: T },
    { type: "add-paired-session", serverId: sid, token: "tok", issuedAt: T },
    { type: "remove-paired-session", serverId: sid, token: "tok", issuedAt: T },
    { type: "backup-app", serverId: sid, creator: "alice", slug: "notes", includeUserData: true, issuedAt: T },
    { type: "set-front-page", serverId: sid, label: "notes", issuedAt: T },
  ];
  const key = newKey(50);
  const other = newKey(51);
  const kp = { publicKey: key.pub, privateKey: key.seed };

  it.each(orders.map((o) => [o.type, o] as const))("AT-ENV-27a %s: control, flipped signature, other key, mutated field", (_t, o) => {
    const sig = P.signPhoneOrder(o, kp);
    expect(P.verifyPhoneOrder(o, sig, key.pub)).toBe(true);
    const bad = Uint8Array.from(sig);
    bad[10] = bad[10]! ^ 1;
    expect(P.verifyPhoneOrder(o, bad, key.pub)).toBe(false);
    expect(P.verifyPhoneOrder(o, sig, other.pub)).toBe(false);
    expect(P.verifyPhoneOrder({ ...o, serverId: "home2.alice.flagship.services" } as P.PhoneOrder, sig, key.pub)).toBe(false);
    expect(P.verifyPhoneOrder({ ...o, issuedAt: T + 1 } as P.PhoneOrder, sig, key.pub)).toBe(false);
  });

  it("AT-ENV-27b one order type's signature is refused for every other type (catches: a noop or front-page signature replayed as power-off / revoke-self)", () => {
    const sigs = orders.map((o) => P.signPhoneOrder(o, kp));
    const accepted: string[] = [];
    orders.forEach((a, i) =>
      orders.forEach((b2, j) => {
        if (i !== j && P.verifyPhoneOrder(b2, sigs[i]!, key.pub)) accepted.push(`${a.type} -> ${b2.type}`);
      }),
    );
    expect(accepted).toEqual([]);
  });

  it("AT-ENV-27c power-off: an `off` signature does not authorize `restart`, and backup-app's password and user-data flag are bound (catches: a captured order re-aimed)", () => {
    const off = { type: "power-off", serverId: sid, mode: "off", issuedAt: T } as P.PhoneOrder;
    const sig = P.signPhoneOrder(off, kp);
    expect(P.verifyPhoneOrder({ ...off, mode: "restart" } as P.PhoneOrder, sig, key.pub)).toBe(false);
    const ba = { type: "backup-app", serverId: sid, creator: "alice", slug: "notes", includeUserData: false, issuedAt: T } as P.PhoneOrder;
    const s2 = P.signPhoneOrder(ba, kp);
    expect(P.verifyPhoneOrder({ ...ba, includeUserData: true } as P.PhoneOrder, s2, key.pub)).toBe(false);
    expect(P.verifyPhoneOrder({ ...ba, password: "x" } as P.PhoneOrder, s2, key.pub)).toBe(false);
  });
});

describe("AT-ENV-28 server-order/v1", () => {
  const V = JSON.parse(readFileSync(join(VECTORS, "server-order/vectors.json"), "utf8"));
  const irk = P.deriveIRK({ seed: fromHex(V.keys.umkSeedHex) });
  const order = V.order.fields as P.ServerOrder;
  const sig: string = V.order.signatureHex;

  it("AT-ENV-28a control: the vector order verifies", () => {
    expect(P.verifyServerOrder(order, sig, irk.publicKey)).toBe(true);
  });

  it("AT-ENV-28b a reordered leader list, an uppercase or padded signature, and another account key are refused (catches: leader hijack by reordering a signed order)", () => {
    if (order.stks.length > 1) expect(P.verifyServerOrder({ ...order, stks: [...order.stks].reverse() }, sig, irk.publicKey)).toBe(false);
    expect(P.verifyServerOrder({ ...order, stks: order.stks.slice(1) }, sig, irk.publicKey)).toBe(false);
    expect(P.verifyServerOrder(order, sig.toUpperCase(), irk.publicKey)).toBe(false);
    expect(P.verifyServerOrder(order, `${sig}00`, irk.publicKey)).toBe(false);
    expect(P.verifyServerOrder(order, "", irk.publicKey)).toBe(false);
    expect(P.verifyServerOrder(order, sig, newKey(60).pub)).toBe(false);
    expect(P.verifyServerOrder({ ...order, user: `${order.user}x` }, sig, irk.publicKey)).toBe(false);
  });
});

describe("AT-ENV-29 rotate-rck/v1 (old RCK AND IRK)", () => {
  const oldRck = newKey(70);
  const irk = newKey(71);
  const r: P.RotateRck = { subdomain: "home.alice.flagship.services", newRckPubKey: newKey(72).pub, oldRckPubKey: oldRck.pub, issuedAt: 1_760_000_000_000, nonce: new Uint8Array(16).fill(3) };
  const { sigOldRck, sigIrk } = P.signRotateRck(r, { publicKey: oldRck.pub, privateKey: oldRck.seed }, { publicKey: irk.pub, privateKey: irk.seed });

  it("AT-ENV-29a control: both signatures verify", () => {
    expect(P.verifyRotateRck(r, sigOldRck, sigIrk, oldRck.pub, irk.pub)).toBe(true);
  });

  it("AT-ENV-29b one signature missing, the two swapped, or both from the same key are refused (catches: a rotation authorized by the old RCK alone or the IRK alone)", () => {
    expect(P.verifyRotateRck(r, sigOldRck, new Uint8Array(64), oldRck.pub, irk.pub)).toBe(false);
    expect(P.verifyRotateRck(r, new Uint8Array(64), sigIrk, oldRck.pub, irk.pub)).toBe(false);
    expect(P.verifyRotateRck(r, sigIrk, sigOldRck, oldRck.pub, irk.pub)).toBe(false);
    expect(P.verifyRotateRck(r, sigIrk, sigIrk, oldRck.pub, irk.pub)).toBe(false);
    expect(P.verifyRotateRck({ ...r, newRckPubKey: newKey(73).pub }, sigOldRck, sigIrk, oldRck.pub, irk.pub)).toBe(false);
  });
});

// ---------------------------------------------------------------- MAC proofs

describe("AT-ENV-30 MAC proofs", () => {
  const V = JSON.parse(readFileSync(join(VECTORS, "server-order/vectors.json"), "utf8"));
  const cgk = fromHex(V.keys.cgkHex);
  const g = V.gossip.fields as P.GossipAnnouncement;

  it("AT-ENV-30a gossip/v2: the MAC verifies only under the account's CGK, untruncated, over the exact fields (catches: a sibling forging leadership without the CGK)", () => {
    const mac: string = V.gossip.macHex;
    expect(P.verifyGossipMac(g, mac, cgk)).toBe(true);
    expect(P.verifyGossipMac(g, mac, new Uint8Array(32).fill(1))).toBe(false);
    expect(P.verifyGossipMac(g, mac.slice(0, 32), cgk)).toBe(false);
    expect(P.verifyGossipMac(g, "", cgk)).toBe(false);
    expect(P.verifyGossipMac({ ...g, liveness: "dead" } as unknown as P.GossipAnnouncement, mac, cgk)).toBe(false);
    expect(P.verifyGossipMac({ ...g, services: [...g.services, "x"] }, mac, cgk)).toBe(false);
  });

  it("AT-ENV-30b enrollment-proof/v1: wrong secret, another server's statement, truncated proof are refused (catches: first-contact proof replayed to another box)", () => {
    const secret = new Uint8Array(32).fill(5);
    const s: P.EnrollmentStatement = { serverDomain: "home.alice.flagship.services", stkPubHex: "07".repeat(32), authCodeSerial: "SERIAL1" };
    const p = P.enrollmentProofHex(secret, s);
    expect(P.verifyEnrollmentProof(secret, s, p)).toBe(true);
    expect(P.verifyEnrollmentProof(new Uint8Array(32).fill(6), s, p)).toBe(false);
    expect(P.verifyEnrollmentProof(secret, { ...s, serverDomain: "home2.alice.flagship.services" }, p)).toBe(false);
    expect(P.verifyEnrollmentProof(secret, { ...s, stkPubHex: "08".repeat(32) }, p)).toBe(false);
    expect(P.verifyEnrollmentProof(secret, s, p.slice(0, 32))).toBe(false);
    expect(P.verifyEnrollmentProof(secret, s, undefined)).toBe(false);
  });

  it("AT-ENV-30c server-code-seen/v1: Studio's MAC binds the server and its key (catches: .com substituting the key Studio saw)", () => {
    const k = new Uint8Array(32).fill(9);
    const mac = P.serverSeenMacHex(k, "home.alice.flagship.services", "07".repeat(32));
    expect(P.verifyServerSeen(k, "home.alice.flagship.services", "07".repeat(32), mac)).toBe(true);
    expect(P.verifyServerSeen(k, "home.alice.flagship.services", "08".repeat(32), mac)).toBe(false);
    expect(P.verifyServerSeen(k, "home2.alice.flagship.services", "07".repeat(32), mac)).toBe(false);
    expect(P.verifyServerSeen(new Uint8Array(32).fill(1), "home.alice.flagship.services", "07".repeat(32), mac)).toBe(false);
    expect(P.verifyServerSeen(k, "home.alice.flagship.services", "07".repeat(32), mac.slice(0, 10))).toBe(false);
  });
});


// ---------------------------------------------------------------- retail box claim receipt

describe("AT-ENV-31 box-claim-receipt/v1 (the box's hybrid-signed receipt the phone checks before trusting its key)", () => {
  const V = JSON.parse(readFileSync(join(VECTORS, "box-claim/vectors.json"), "utf8"));
  const t = V.transcripts[0];
  const expectFor = { transcriptHex: t.transcriptHex, mode: t.mode, serverDomain: V.serverDomain, serial: V.serial };
  const refused = (wire: unknown) => throws(() => P.verifyBoxClaimReceipt(wire, expectFor));
  const stk = hybridSigKeygen(fromHex(V.stk.ed25519SeedHex), fromHex(V.stk.mldsaSeedHex));
  const other = hybridSigKeygen(seed(41), seed(42));
  const { signature: _sig, v: _v, ...fields } = t.receipt;
  const canon = P.canonicalBoxClaimReceipt(fields);

  it("AT-ENV-31a control: the vector receipt verifies", () => {
    expect(refused(t.receipt)).toBe(false);
    expect(toHex(stk.publicKey)).toBe(t.receipt.stkHybridPub);
  });

  it("AT-ENV-31b one flipped bit in either half is refused (catches: a verifier that checks only one half)", () => {
    for (const at of [0, 63, 64, 3000]) {
      const sig = fromHex(t.receipt.signature);
      sig[at] = sig[at]! ^ 1;
      expect(refused({ ...t.receipt, signature: toHex(sig) }), `byte ${at}`).toBe(true);
    }
  });

  it("AT-ENV-31c the Ed25519 half of another receipt spliced onto this one's ML-DSA half is refused (catches: half-and-half splicing)", () => {
    const otherSig = hybridSign(stk.secretKey, P.TAG_BOX_CLAIM_RECEIPT, P.canonicalBoxClaimReceipt({ ...fields, model: "Other" }), { deterministic: true });
    const spliced = fromHex(t.receipt.signature);
    spliced.set(otherSig.subarray(0, 64), 0);
    expect(refused({ ...t.receipt, signature: toHex(spliced) })).toBe(true);
  });

  it("AT-ENV-31d the same bytes signed under another purpose are refused (catches: a signature for another family relabelled as a receipt)", () => {
    const relabelled = hybridSign(stk.secretKey, "flagship/server-order/v1", canon, { deterministic: true });
    expect(refused({ ...t.receipt, signature: toHex(relabelled) })).toBe(true);
  });

  it("AT-ENV-31e another box's signature over a receipt naming this box's key is refused (catches: a relay signing for the real box)", () => {
    const forged = hybridSign(other.secretKey, P.TAG_BOX_CLAIM_RECEIPT, canon, { deterministic: true });
    expect(refused({ ...t.receipt, signature: toHex(forged) })).toBe(true);
  });

  it("AT-ENV-31f changing any signed field breaks the receipt (catches: a field left out of the signed bytes)", () => {
    const changes: Record<string, unknown> = {
      mode: t.mode === "open" ? "code" : "open",
      serverDomain: "home2.alice.flagship.services",
      serial: "another-serial-01",
      stkHybridPub: toHex(other.publicKey),
      bootKeyBindingSha256: t.receipt.bootKeyBindingSha256 === "" ? "ab".repeat(32) : "",
      model: "Other",
      imageVersion: "9.9.9",
      transcript: "cd".repeat(64),
      issuedAt: t.receipt.issuedAt + 1,
    };
    for (const [k, val] of Object.entries(changes)) expect(refused({ ...t.receipt, [k]: val }), k).toBe(true);
  });

  it("AT-ENV-31g truncated, empty, extra-key and wrong-version receipts are refused (catches: shape bugs)", () => {
    expect(refused({ ...t.receipt, signature: t.receipt.signature.slice(0, -2) })).toBe(true);
    expect(refused({ ...t.receipt, signature: "" })).toBe(true);
    expect(refused({ ...t.receipt, extra: 1 })).toBe(true);
    expect(refused({ ...t.receipt, v: 2 })).toBe(true);
  });
});

// ---------------------------------------------------------------- enterprise: org servers, key ring, audit

describe("AT-ENV-32..36 enterprise org servers, key rings and audit export", () => {
  const A = JSON.parse(readFileSync(join(VECTORS, "org-authority/vectors.json"), "utf8"));
  const V = JSON.parse(readFileSync(join(VECTORS, "org-servers/vectors.json"), "utf8"));
  const refs = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(refs);
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if (typeof o.$key === "string") return A.keys[o.$key].binding;
    if (typeof o.$approval === "number") return A.approvals[o.$approval];
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, refs(x)]));
  };
  const entries = refs(A.chains[0]).entries.slice(0, 2);
  const grants = refs(A.seatBooks[0]).grants;
  const at = (now: number) => {
    const state = P.verifyOrgAuthorityChain(entries, { genesisHash: A.genesisHash, now });
    return { state, book: P.buildOrgSeatBook(state, { grants, revokes: [], now }) };
  };
  const flipHex = (h: string, i = 0) => h.slice(0, i) + (h[i] === "0" ? "1" : "0") + h.slice(i + 1);
  const H32 = (c: string) => c.repeat(64);

  describe("AT-ENV-32 org-server-code/v2 (the org's AuthCode, authorized by org approvals)", () => {
    const c = V.serverCodes[0];
    const { state, book } = at(c.now);
    const verify = (code: unknown, approvals = c.approvals) => !throws(() => P.verifyOrgServerCode(state, book, code as never, approvals, c.now));

    it("AT-ENV-32a control: the vector code verifies under one org admin's approval", () => {
      expect(verify(c.code)).toBe(true);
    });

    it("AT-ENV-32b changing any field of the code breaks its approval (catches: a field left out of the approved bytes)", () => {
      const changes: Record<string, unknown> = {
        serial: "orgsrv-0002-abcd",
        serverName: "work",
        serverDomain: "home.other.flagship.services",
        delegatedPubKeyHex: H32("e"),
        enrolmentPubKeyHex: H32("f"),
        issuedAt: c.code.issuedAt + 1,
        expiresAt: c.code.expiresAt - 1,
      };
      for (const [k, v] of Object.entries(changes)) expect(verify({ ...c.code, [k]: v }), k).toBe(false);
      expect(verify({ ...c.code, serverName: "work", serverDomain: "work.acme.flagship.services" })).toBe(false);
    });

    it("AT-ENV-32c no field can carry the separator into its neighbour (catches: canonical-join ambiguity)", () => {
      const shifted = [
        { ...c.code, serial: `${c.code.serial}|${c.code.serverName}` },
        { ...c.code, serverName: `${c.code.serverName}|x` },
        { ...c.code, serverDomain: `${c.code.serverDomain}|${c.code.delegatedPubKeyHex}` },
        { ...c.code, delegatedPubKeyHex: `${c.code.delegatedPubKeyHex}|${c.code.enrolmentPubKeyHex}` },
      ];
      for (const x of shifted) expect(throws(() => P.canonicalOrgServerCode(x))).toBe(true);
    });

    it("AT-ENV-32d a flipped approval signature, or none, is refused (catches: approvals counted without checking them)", () => {
      const a = c.approvals[0];
      expect(verify(c.code, [{ ...a, signature: flipHex(a.signature) }])).toBe(false);
      expect(verify(c.code, [{ ...a, signature: flipHex(a.signature, 200) }])).toBe(false);
      expect(verify(c.code, [])).toBe(false);
    });
  });

  describe("AT-ENV-33 org-server-register/v1 (the box's STK proof over the code's hash)", () => {
    const r = V.register.request;
    const sig = V.register.signature;
    const stkSeed = fromHex(V.register.stkSeedHex);

    it("AT-ENV-33a control: the vector registration verifies", () => {
      expect(P.verifyOrgServerRegister(r, sig)).toBe(true);
    });

    it("AT-ENV-33b a flipped, truncated or upper-case signature is refused", () => {
      expect(P.verifyOrgServerRegister(r, flipHex(sig))).toBe(false);
      expect(P.verifyOrgServerRegister(r, flipHex(sig, 127))).toBe(false);
      expect(P.verifyOrgServerRegister(r, sig.slice(0, 126))).toBe(false);
      expect(P.verifyOrgServerRegister(r, sig.toUpperCase())).toBe(false);
    });

    it("AT-ENV-33c another box's key cannot sign for the named key, and the signer must be the named key (catches: a relay registering for the real box)", () => {
      const other = seed(51);
      expect(throws(() => P.signOrgServerRegister(r, other))).toBe(true);
      const forged = toHex(ed25519.sign(P.canonicalOrgServerRegister(r), other));
      expect(P.verifyOrgServerRegister(r, forged)).toBe(false);
      const self = { ...r, serverIdentityPubKeyHex: toHex(ed25519.getPublicKey(other)) };
      expect(P.verifyOrgServerRegister(self, sig)).toBe(false);
      expect(P.verifyOrgServerRegister(r, P.signOrgServerRegister(r, stkSeed))).toBe(true);
    });

    it("AT-ENV-33d changing any field breaks the signature, and no field can carry the separator", () => {
      const changes: Record<string, unknown> = {
        orgId: "0b".repeat(16),
        serial: "orgsrv-0002-abcd",
        serverDomain: "work.acme.flagship.services",
        codeSha256: H32("c"),
        issuedAt: r.issuedAt + 1,
        nonceHex: "cd".repeat(16),
      };
      for (const [k, v] of Object.entries(changes)) expect(P.verifyOrgServerRegister({ ...r, [k]: v }, sig), k).toBe(false);
      expect(P.verifyOrgServerRegister({ ...r, serial: `${r.serial}|${r.serverDomain}` }, sig)).toBe(false);
      expect(throws(() => P.canonicalOrgServerRegister({ ...r, serverDomain: `${r.serverDomain}|${r.codeSha256}` }))).toBe(true);
    });
  });

  describe("AT-ENV-34 org-seat-kem/v1 and org-box-kem/v1 (who a key-ring copy is sealed to)", () => {
    const now = V.keyRings[0].now;
    const { state, book } = at(now);
    const stkPub = V.register.request.serverIdentityPubKeyHex;
    const box = V.kems.box[0];
    const seat = V.kems.seat[0];
    const boxOk = (b: unknown, pub = stkPub) => !throws(() => P.verifyOrgBoxKem(b as never, V.orgId, pub, now));
    const seatOk = (b: unknown) => !throws(() => P.verifyOrgSeatKem(state, book, b as never, now));

    it("AT-ENV-34a control: both vector statements verify", () => {
      expect(boxOk(box)).toBe(true);
      expect(seatOk(seat)).toBe(true);
    });

    it("AT-ENV-34b a flipped signature is refused (both halves of the seat's hybrid signature)", () => {
      expect(boxOk({ ...box, signature: flipHex(box.signature) })).toBe(false);
      for (const i of [0, 127, 200, 6000]) expect(seatOk({ ...seat, signature: flipHex(seat.signature, i) }), `byte ${i / 2}`).toBe(false);
    });

    it("AT-ENV-34c another box's STK, or a box key signed for another org, is refused", () => {
      const other = seed(52);
      const forged = { ...box, signature: P.signOrgBoxKem(box.statement, other) };
      expect(boxOk(forged)).toBe(false);
      expect(boxOk(box, toHex(ed25519.getPublicKey(other)))).toBe(false);
      expect(!throws(() => P.verifyOrgBoxKem(box, "0b".repeat(16), stkPub, now))).toBe(false);
    });

    it("AT-ENV-34d changing any statement field, or swapping the KEM key, breaks it", () => {
      for (const [k, v] of Object.entries({ serverDomain: "work.acme.flagship.services", kemKeyId: H32("4"), issuedAt: box.statement.issuedAt + 1 }))
        expect(boxOk({ ...box, statement: { ...box.statement, [k]: v } }), `box ${k}`).toBe(false);
      for (const [k, v] of Object.entries({ seatId: "b2".repeat(16), kemKeyId: H32("4"), issuedAt: seat.statement.issuedAt + 1 }))
        expect(seatOk({ ...seat, statement: { ...seat.statement, [k]: v } }), `seat ${k}`).toBe(false);
      expect(boxOk({ ...box, kemPubHex: V.kems.box.at(-1).kemPubHex === box.kemPubHex ? seat.kemPubHex : V.kems.box.at(-1).kemPubHex })).toBe(false);
      expect(seatOk({ ...seat, kemPubHex: box.kemPubHex })).toBe(false);
    });
  });

  describe("AT-ENV-35 org-key-ring/v1 (versioned key records approved by org admins)", () => {
    const c = V.keyRings[0];
    const ctx = () => {
      const { state, book } = at(c.now);
      const kems = P.newestOrgKems([
        ...V.kems.seat.flatMap((k: never) => {
          try {
            return [P.verifyOrgSeatKem(state, book, k, c.now)];
          } catch {
            return [];
          }
        }),
        ...V.kems.box.map((k: never) => P.verifyOrgBoxKem(k, V.orgId, V.register.request.serverIdentityPubKeyHex, c.now)),
      ]);
      return { state, book, kems, servers: new Set<string>(V.servers), now: c.now };
    };
    const ok = (bundle: unknown, prev: unknown = c.prev) => !throws(() => P.verifyOrgKeyRing(ctx(), bundle as never, prev as never, { fresh: c.fresh }));

    it("AT-ENV-35a control: the vector v1 ring verifies", () => {
      expect(ok(c.bundle)).toBe(true);
    });

    it("AT-ENV-35b changing any ring field breaks the admins' approval (catches: a version record edited after approval)", () => {
      const r = c.bundle.ring;
      const changes: Record<string, unknown> = {
        scope: "work.acme.flagship.services",
        version: 2,
        prevSha256: H32("1"),
        keyCommitment: H32("2"),
        recipientsHash: H32("3"),
        retired: ["b2".repeat(16)],
        oarVersion: r.oarVersion + 1,
        issuedAt: r.issuedAt + 1,
      };
      for (const [k, v] of Object.entries(changes)) expect(ok({ ...c.bundle, ring: { ...r, [k]: v } }), k).toBe(false);
      expect(ok({ ...c.bundle, ring: { ...r, kind: "disk-key" } })).toBe(false);
    });

    it("AT-ENV-35c a flipped approval, no approval, or a dropped recipient is refused", () => {
      const a = c.bundle.approvals[0];
      expect(ok({ ...c.bundle, approvals: [{ ...a, signature: flipHex(a.signature) }] })).toBe(false);
      expect(ok({ ...c.bundle, approvals: [] })).toBe(false);
      expect(ok({ ...c.bundle, recipients: c.bundle.recipients.slice(1) })).toBe(false);
    });

    it("AT-ENV-35d no ring or commitment field can carry the separator", () => {
      const r = c.bundle.ring;
      expect(throws(() => P.canonicalOrgKeyRing({ ...r, scope: `${r.scope}|1` }))).toBe(true);
      expect(throws(() => P.orgKeyCommitment(r.orgId, r.kind, `${r.scope}|1`, r.version, new Uint8Array(32)))).toBe(true);
      expect(throws(() => P.orgKeyCommitment(`${r.orgId}|x`, r.kind, r.scope, r.version, new Uint8Array(32)))).toBe(true);
    });
  });

  describe("AT-ENV-36 org-audit-export/v1 and the org-log/v1 chain (what an auditor checks offline)", () => {
    const ok0 = V.audit.cases[0];
    const verify = (x: unknown) => !throws(() => P.verifyOrgAuditExport(x as never, { genesisHash: V.genesisHash, now: ok0.now }));

    it("AT-ENV-36a control: the vector export verifies offline", () => {
      expect(verify(V.audit.export)).toBe(true);
    });

    it("AT-ENV-36b changing any statement field breaks the admin's approval", () => {
      const st = V.audit.export.statement;
      for (const [k, v] of Object.entries({ oarVersion: st.oarVersion + 1, oarHash: H32("5"), logSeq: st.logSeq - 1, logHeadHash: H32("6"), issuedAt: st.issuedAt + 1 }))
        expect(verify({ ...V.audit.export, statement: { ...st, [k]: v } }), k).toBe(false);
    });

    it("AT-ENV-36c a rewritten, dropped or reordered log entry is refused (catches: .com editing history under a signed head)", () => {
      const x = structuredClone(V.audit.export);
      x.log[2].refSha256 = H32("7");
      expect(verify(x)).toBe(false);
      const y = structuredClone(V.audit.export);
      y.log.splice(3, 1);
      expect(verify(y)).toBe(false);
      const z = structuredClone(V.audit.export);
      [z.log[1], z.log[2]] = [z.log[2], z.log[1]];
      expect(verify(z)).toBe(false);
    });

    it("AT-ENV-36d a separator moved between a log entry's kind and its object hash is refused (catches: one chained hash naming two objects)", () => {
      const e = V.audit.export.log[1];
      expect(throws(() => P.orgLogEntryHash(V.orgId, e.seq, e.prevHash, `${e.kind}|${e.refSha256}`, "", e.at))).toBe(true);
      expect(throws(() => P.orgLogEntryHash(V.orgId, e.seq, e.prevHash, e.kind, `${e.refSha256}|1`, e.at))).toBe(true);
      expect(P.orgLogEntryHash(V.orgId, e.seq, e.prevHash, e.kind, e.refSha256, e.at)).toBe(e.entryHash);
    });

    it("AT-ENV-36e a flipped approval signature is refused", () => {
      const a = V.audit.export.approval;
      expect(verify({ ...V.audit.export, approval: { ...a, signature: flipHex(a.signature) } })).toBe(false);
      expect(verify({ ...V.audit.export, approval: { ...a, signature: flipHex(a.signature, 300) } })).toBe(false);
    });
  });
});
