import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PqTrustError,
  canonicalPqKeyBinding,
  hybridSign,
  legacyPolicyState,
  messagePurpose,
  signPqKeyBinding,
  verifiedBootKeyGated,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  bootKeyBindingToWire,
  signBootKeyBinding,
  signBootKeyBindingV2,
  ed,
  type PolicyState,
  type PqBindingExpectation,
  type VerifiedPqKeyBinding,
  type SignatureSuite,
} from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/pq-binding/vectors.json", import.meta.url), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof PqTrustError) return e.code;
    throw e;
  }
  return "ok";
};
const policy = (p: { profile: string; rollout: string }): PolicyState => ({
  ...legacyPolicyState({ kind: "installation", id: "home.alice.flagship.services" }),
  profile: p.profile as PolicyState["profile"],
  rollout: p.rollout as PolicyState["rollout"],
});
const signerSecret = (name: string) => {
  const s = V.signers.find((x: { name: string }) => x.name === name);
  return unhex(s.edSeedHex + s.mldsaSeedHex);
};

describe("pq key bindings (shared vectors)", () => {
  const bindings = new Map<string, VerifiedPqKeyBinding>();
  for (const v of V.bindings.valid) {
    it(`verifies ${v.name}`, () => {
      expect(Buffer.from(canonicalPqKeyBinding(v.wire)).toString("hex")).toBe(v.statementHex);
      const b = verifyPqKeyBinding(v.wire, v.expect as PqBindingExpectation);
      expect(b.mldsaPubHex).toBe(v.wire.mldsaPubHex);
      bindings.set(v.name, b);
    });
  }
  for (const v of V.bindings.invalid) {
    it(`refuses ${v.name} with ${v.code}`, () => {
      expect(code(() => verifyPqKeyBinding(v.wire, v.expect as PqBindingExpectation))).toBe(v.code);
    });
  }
  it("signs a binding byte for byte as the vectors (deterministic ML-DSA)", () => {
    const v = V.bindings.valid.find((x: { name: string }) => x.name === "box-stk");
    const { signature: _s, v: _v, ...st } = v.wire;
    const secret = signerSecret("A");
    const w = signPqKeyBinding(st, (m) => hybridSign(secret, messagePurpose(m), m, { deterministic: true }));
    expect(w).toEqual(v.wire);
  });

  describe("gate", () => {
    for (const c of V.gate) {
      it(`${c.name}`, () => {
        const vb = V.bindings.valid.find((x: { name: string }) => x.name === c.binding);
        const binding = vb ? verifyPqKeyBinding(vb.wire, vb.expect) : null;
        const run = () =>
          verifyCriticalSignature({
            message: unhex(c.messageHex),
            expectedPurpose: c.expectedPurpose,
            envelope: { suite: c.envelope.suite as SignatureSuite, signature: c.envelope.signature },
            signerEd25519PubHex: c.signerEd25519PubHex,
            binding,
            policy: policy(c.policy),
          });
        if (c.expect.ok) expect(run()).toEqual({ suite: c.expect.suite, strict: c.expect.strict });
        else expect(code(run)).toBe(c.expect.code);
      });
    }
    it("refuses a binding look-alike that did not come from verifyPqKeyBinding", () => {
      const vb = V.bindings.valid.find((x: { name: string }) => x.name === "box-stk");
      const real = verifyPqKeyBinding(vb.wire, vb.expect);
      const fake = { ...real };
      const c = V.gate.find((x: { name: string }) => x.name === "strict-hybrid");
      expect(
        code(() =>
          verifyCriticalSignature({ message: unhex(c.messageHex), expectedPurpose: c.expectedPurpose, envelope: c.envelope, signerEd25519PubHex: c.signerEd25519PubHex, binding: fake, policy: policy(c.policy) }),
        ),
      ).toBe("no-binding");
    });
  });

  describe("boot key binding v2 through the gate", () => {
    const vb = V.bindings.valid.find((x: { name: string }) => x.name === "box-stk");
    const stkSecret = signerSecret("A");
    const stkSeed = stkSecret.subarray(0, 32);
    const domain = vb.wire.subjectId;
    const boot = { serverDomain: domain, bootPubHex: V.signers[1].ed25519PubHex, issuedAt: 5 };
    const hyb = (m: Uint8Array) => hybridSign(stkSecret, messagePurpose(m), m);
    const v1sig = signBootKeyBinding(boot, (m) => ed.sign(m, stkSeed));
    const stkBinding = verifyPqKeyBinding(vb.wire, vb.expect);
    const base = { serverDomain: domain, stkPubHex: vb.wire.ed25519PubHex, stkBinding };
    const strict = policy({ profile: "strict", rollout: "enforced" });
    const compat = policy({ profile: "compatibility", rollout: "legacy" });

    it("accepts v1 only while strict is not in force", () => {
      const w = bootKeyBindingToWire(boot, v1sig);
      expect(verifiedBootKeyGated(w, { ...base, policy: compat })).toEqual({ bootPubHex: boot.bootPubHex, hybrid: false });
      expect(verifiedBootKeyGated(w, { ...base, policy: strict })).toBeNull();
    });
    it("accepts v1 + v2 under strict, and refuses a v2 for other fields", () => {
      const w = bootKeyBindingToWire(boot, v1sig, signBootKeyBindingV2(boot, hyb));
      expect(verifiedBootKeyGated(w, { ...base, policy: strict })).toEqual({ bootPubHex: boot.bootPubHex, hybrid: true });
      const other = bootKeyBindingToWire(boot, v1sig, signBootKeyBindingV2({ ...boot, issuedAt: 6 }, hyb));
      expect(verifiedBootKeyGated(other, { ...base, policy: compat })).toBeNull();
      expect(verifiedBootKeyGated(w, { ...base, stkBinding: null, policy: compat })).toBeNull();
    });
  });
});

describe("pinning a box's ML-DSA key (decideBoxPqKeyPin)", () => {
  it("first, match, mismatch on another key, invalid under another STK or older than the pin", async () => {
    const { decideBoxPqKeyPin } = await import("../src/index.js");
    const vb = V.bindings.valid.find((x: { name: string }) => x.name === "box-stk");
    const d = vb.wire.subjectId;
    const stk = vb.wire.ed25519PubHex;
    expect(decideBoxPqKeyPin({ stkHex: stk }, d, vb.wire, V.now)).toMatchObject({ verdict: "first", mldsaPubHex: vb.wire.mldsaPubHex });
    expect(decideBoxPqKeyPin({ stkHex: stk, mldsaPubHex: vb.wire.mldsaPubHex }, d, vb.wire, V.now).verdict).toBe("match");
    expect(decideBoxPqKeyPin({ stkHex: stk, mldsaPubHex: V.signers[1].mldsaPubHex }, d, vb.wire, V.now)).toEqual({ verdict: "mismatch", code: "binding-pq-key-changed" });
    expect(decideBoxPqKeyPin({ stkHex: V.signers[1].ed25519PubHex }, d, vb.wire, V.now)).toEqual({ verdict: "invalid", code: "binding-key-mismatch" });
    expect(decideBoxPqKeyPin({ stkHex: stk, minIssuedAt: vb.wire.issuedAt + 1 }, d, vb.wire, V.now)).toEqual({ verdict: "invalid", code: "binding-stale" });
  });
});
