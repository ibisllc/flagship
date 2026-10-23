// The browser verifies a box's hybrid key binding under the STK it pinned, pins the ML-DSA key,
// and then needs the boot-key binding's hybrid signature (lib/pqBinding.js, lib/boxKeyPins.js;
// shared vectors packages/protocol/test-vectors/pq-binding).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bootKeyBindingToWire,
  canonicalPqKeyBinding as tsCanonical,
  ed,
  hybridSign,
  messagePurpose,
  signBootKeyBinding,
  signBootKeyBindingV2,
} from "@flagship/protocol";
import { PqBindingError, canonicalPqKeyBinding, verifyCriticalSignature, verifyPqKeyBinding } from "../public/webapp/lib/pqBinding.js";
import { BoxKeyChangedError, acceptBootKeyBinding, acceptStkPqBinding, pinnedBootKey, pinnedBoxPqKey, repinBoxKey } from "../public/webapp/lib/boxKeyPins.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/pq-binding/vectors.json"), "utf8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof PqBindingError) return e.code;
    throw e;
  }
  return "ok";
};
const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, val: string) => void m.set(k, val) };
};

describe("pq key bindings in the webapp: shared vectors", () => {
  for (const c of V.bindings.valid) {
    it(`verifies ${c.name}`, () => {
      expect(hex(canonicalPqKeyBinding(c.wire))).toBe(c.statementHex);
      expect(verifyPqKeyBinding(c.wire, c.expect).mldsaPubHex).toBe(c.wire.mldsaPubHex);
    });
  }
  for (const c of V.bindings.invalid) {
    it(`refuses ${c.name} with ${c.code}`, () => expect(code(() => verifyPqKeyBinding(c.wire, c.expect))).toBe(c.code));
  }
});

describe("the critical-signature gate in the webapp: shared vectors", () => {
  const policy = (p: { profile: string; rollout: string }) => ({ scope: { kind: "installation", id: "x" }, ...p, generation: 1, headDigest: "0".repeat(64), enforcedEver: false });
  for (const c of V.gate) {
    it(c.name, () => {
      const vb = V.bindings.valid.find((x: { name: string }) => x.name === c.binding);
      const binding = vb ? verifyPqKeyBinding(vb.wire, vb.expect) : null;
      const run = () =>
        verifyCriticalSignature({ message: unhex(c.messageHex), expectedPurpose: c.expectedPurpose, envelope: c.envelope, signerEd25519PubHex: c.signerEd25519PubHex, binding, policy: policy(c.policy) });
      if (c.expect.ok) expect(run()).toEqual({ suite: c.expect.suite, strict: c.expect.strict });
      else expect(code(run)).toBe(c.expect.code);
    });
  }
  it("refuses a binding look-alike", () => {
    const vb = V.bindings.valid.find((x: { name: string }) => x.name === "box-stk");
    const fake = { ...verifyPqKeyBinding(vb.wire, vb.expect) };
    const c = V.gate.find((x: { name: string }) => x.name === "strict-hybrid");
    const run = () => verifyCriticalSignature({ message: unhex(c.messageHex), expectedPurpose: c.expectedPurpose, envelope: c.envelope, signerEd25519PubHex: c.signerEd25519PubHex, binding: fake, policy: policy(c.policy) });
    expect(code(run)).toBe("no-binding");
  });
});

describe("pinning the box's ML-DSA key", () => {
  const signer = V.signers[0];
  const secret = unhex(signer.edSeedHex + signer.mldsaSeedHex);
  const D = "home.alice.flagship.services";
  const U = "plucky-avocet";
  const sign = (m: Uint8Array) => hybridSign(secret, messagePurpose(m), m);
  const bind = (issuedAt: number, s = secret, ml = signer.mldsaPubHex) => {
    const st = { role: "box-stk" as const, subjectId: D, ed25519PubHex: signer.ed25519PubHex, mldsaPubHex: ml, issuedAt };
    return { v: 1, ...st, signature: hex(hybridSign(s, messagePurpose(tsCanonical(st)), tsCanonical(st))) };
  };
  const deps = () => ({ pinStorage: memStorage(), now: () => V.now });

  it("pins only under the pinned STK, refuses another ML-DSA key and an older binding", () => {
    const d = deps();
    expect(acceptStkPqBinding(U, D, bind(10), d)).toBeNull();
    repinBoxKey(U, D, signer.ed25519PubHex, d);
    expect(acceptStkPqBinding(U, D, bind(10), d)).toBe(signer.mldsaPubHex);
    expect(pinnedBoxPqKey(U, D, d)).toBe(signer.mldsaPubHex);
    expect(acceptStkPqBinding(U, D, bind(5), d)).toBeNull();
    const other = V.signers[1];
    const swapped = bind(11, unhex(signer.edSeedHex + other.mldsaSeedHex), other.mldsaPubHex);
    expect(() => acceptStkPqBinding(U, D, swapped, d)).toThrow(BoxKeyChangedError);
    expect(acceptStkPqBinding(U, D, { ...bind(12), subjectId: "x.alice.flagship.services" }, d)).toBeNull();
  });

  it("then needs the boot-key binding's hybrid signature", async () => {
    const d = deps();
    repinBoxKey(U, D, signer.ed25519PubHex, d);
    const boot = { serverDomain: D, bootPubHex: V.signers[2].ed25519PubHex, issuedAt: 7 };
    const v1 = hex(signBootKeyBinding(boot, (m) => ed.sign(m, unhex(signer.edSeedHex))));
    expect(await acceptBootKeyBinding(U, D, boot, v1, d)).toBe(boot.bootPubHex);
    acceptStkPqBinding(U, D, bind(10), d);
    const next = { ...boot, issuedAt: 8 };
    const v1n = hex(signBootKeyBinding(next, (m) => ed.sign(m, unhex(signer.edSeedHex))));
    expect(await acceptBootKeyBinding(U, D, next, v1n, d)).toBeNull();
    const w = bootKeyBindingToWire(next, unhex(v1n), signBootKeyBindingV2(next, sign));
    expect(await acceptBootKeyBinding(U, D, next, v1n, d, w.hybridSignature)).toBe(next.bootPubHex);
    expect(pinnedBootKey(U, D, d)).toBe(next.bootPubHex);
  });

  it("needs it on a strict server even before an ML-DSA pin", async () => {
    const d = { ...deps(), policy: { scope: { kind: "installation", id: D }, profile: "strict", rollout: "enforced", generation: 1, headDigest: "0".repeat(64), enforcedEver: true } };
    repinBoxKey(U, D, signer.ed25519PubHex, d);
    const boot = { serverDomain: D, bootPubHex: V.signers[2].ed25519PubHex, issuedAt: 7 };
    const v1 = hex(signBootKeyBinding(boot, (m) => ed.sign(m, unhex(signer.edSeedHex))));
    expect(await acceptBootKeyBinding(U, D, boot, v1, d)).toBeNull();
  });
});
