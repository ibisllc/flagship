// The webapp's half of packages/protocol/test-vectors/account-key-rotation: every canonical form,
// the classical signatures and the X-Wing seal re-made byte for byte, and every hop, companion,
// delivery, plaintext, kept-device and derived-key case (lib/accountKeyRotation.js). The box's
// chain cases are TypeScript only.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as A from "../public/webapp/lib/accountKeyRotation.js";
import { PqBindingError, verifyPqKeyBinding } from "../public/webapp/lib/pqBinding.js";
import { hybridSealKeygen } from "../public/webapp/lib/voiciCore.js";

const V = JSON.parse(readFileSync(join(__dirname, "../../../packages/protocol/test-vectors/account-key-rotation/vectors.json"), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof A.AccountKeyRotationError || e instanceof PqBindingError) return (e as { code: string }).code;
    return `other:${String(e)}`;
  }
};
const want = (e: { ok: boolean; code?: string }) => (e.ok ? "ok" : e.code);
const verified = (name: string | null) => {
  if (name === null) return null;
  const w = V.bindings[name];
  return verifyPqKeyBinding(w, { role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: V.now });
};
const K = V.keys;

describe("account-key-rotation vectors in the webapp", () => {
  it("builds every canonical form and digest", () => {
    expect(utf8(A.canonicalAccountKeyRotation(V.rotation.fields))).toBe(V.rotation.canonical);
    expect(A.accountKeyRotationDigestHex(V.rotation.fields)).toBe(V.rotation.digestHex);
    expect(A.keptDevicesLines(V.keptDevices.list)).toBe(V.keptDevices.lines);
    expect(A.keptDevicesDigestHex(V.keptDevices.list)).toBe(V.keptDevices.digestHex);
    expect(A.bindingKeyIdHex(V.bindings.newIrk)).toBe(V.pq.newIrkKeyIdHex);
    expect(utf8(A.canonicalAccountKeyRotationV2(V.rotation.fields, V.pq.newIrkKeyIdHex))).toBe(V.pq.canonicalV2);
    for (const k of ["xwing", "ed25519"]) expect(utf8(A.canonicalUmkRotationDelivery(V.delivery[k].delivery))).toBe(V.delivery[k].canonical);
    expect(utf8(A.canonicalDeviceKeyRotate(V.deviceKeyRotate.fields))).toBe(V.deviceKeyRotate.canonical);
    expect(utf8(A.canonicalDeviceReceiveKey(V.deviceReceiveKey.fields))).toBe(V.deviceReceiveKey.canonical);
    expect(utf8(A.canonicalCgkRekey(V.cgkRekey.fields))).toBe(V.cgkRekey.canonical);
    expect(utf8(A.canonicalSwkRekey(V.swkRekey.fields))).toBe(V.swkRekey.canonical);
    expect(utf8(A.canonicalLuksRekeyConfirm(V.luksRekeyConfirm.fields))).toBe(V.luksRekeyConfirm.canonical);
    expect(hex(A.deriveIrkSeedInScheme(unhex(K.oldUmkHex), "web", 2))).toBe(K.oldIrk.seedHex);
    expect(hex(A.deriveIrkSeedInScheme(unhex(K.newUmkHex), "ios", 1))).toBe(K.newIrk.seedHex);
    expect(hex(A.deriveAidSeed(unhex(K.newUmkHex)))).toBe(K.newAid.seedHex);
  });

  it("re-signs every classical signature byte for byte", () => {
    expect(A.signAccountKeyRotation(V.rotation.fields, { adminRootSeed: unhex(K.adminRoot.seedHex), newIrkSeed: unhex(K.newIrk.seedHex), newAidSeed: unhex(K.newAid.seedHex) })).toEqual(V.rotation.signatures);
    expect(A.signDeviceKeyRotate(V.deviceKeyRotate.fields, { newKeySeed: unhex(K.devices.eNew.seedHex), adminRootSeed: unhex(K.adminRoot.seedHex) })).toEqual({
      newKeySignatureHex: V.deviceKeyRotate.newKeySignatureHex,
      adminRootSignatureHex: V.deviceKeyRotate.adminRootSignatureHex,
    });
    expect(A.signDeviceReceiveKey(V.deviceReceiveKey.fields, unhex(K.devices.b.seedHex))).toBe(V.deviceReceiveKey.signatureHex);
    const seed = (s: string) => unhex(s === "newIrk" ? K.newIrk.seedHex : K.adminRoot.seedHex);
    expect(A.signRekey(A.canonicalCgkRekey(V.cgkRekey.fields), seed(V.cgkRekey.signer))).toBe(V.cgkRekey.signatureHex);
    expect(A.signRekey(A.canonicalSwkRekey(V.swkRekey.fields), seed(V.swkRekey.signer))).toBe(V.swkRekey.signatureHex);
    expect(A.signRekey(A.canonicalLuksRekeyConfirm(V.luksRekeyConfirm.fields), seed(V.luksRekeyConfirm.signer))).toBe(V.luksRekeyConfirm.signatureHex);
    const dkr = V.deviceKeyRotate;
    expect(A.verifyDeviceKeyRotate(dkr.fields, dkr, K.adminRoot.pubHex)).toBe(true);
    expect(A.verifyDeviceKeyRotate(dkr.fields, dkr, K.other.pubHex)).toBe(false);
    expect(A.verifyDeviceReceiveKey(V.deviceReceiveKey.fields, V.deviceReceiveKey.signatureHex)).toBe(true);
    expect(A.verifyRekey(() => A.canonicalLuksRekeyConfirm(V.luksRekeyConfirm.fields), V.luksRekeyConfirm.signatureHex, K.adminRoot.pubHex)).toBe(false);
  });

  for (const c of V.hopCases) {
    it(`hop: ${c.name}`, () => {
      expect(code(() => A.verifyAccountKeyRotation({ rotation: c.rotation, signatures: c.signatures, state: c.state }))).toBe(want(c.expect));
    });
  }

  for (const c of V.pqCases) {
    it(`companion: ${c.name}`, () => {
      const pq = c.signature === null ? null : { signature: V.pqSignatures[c.signature], newIrkBinding: V.bindings[c.binding] };
      expect(code(() => A.verifyAccountKeyRotationPq({ rotation: V.rotation.fields, pq, adminRootBinding: verified(c.adminRootBinding), policy: c.policy, now: V.now }))).toBe(want(c.expect));
    });
  }

  it("re-seals both deliveries byte for byte and rebuilds their signatures", () => {
    const x = V.delivery.xwing;
    const recv = hybridSealKeygen(unhex(K.bReceive.seedHex));
    expect(hex(recv.publicKey)).toBe(K.bReceive.pubHex);
    expect(hex(A.sealUmkRotation({ rotation: V.rotation.fields, deviceId: K.deviceIds.b, plaintext: unhex(x.plaintextHex), recipient: { kind: "xwing", publicKey: recv.publicKey }, issuedAt: x.issuedAt, randomness: { xwing: unhex(x.randomnessHex) } }).sealed)).toBe(x.sealedHex);
    const e = V.delivery.ed25519;
    expect(hex(A.sealUmkRotation({ rotation: V.rotation.fields, deviceId: K.deviceIds.c, plaintext: unhex(e.plaintextHex), recipient: { kind: "ed25519", devicePub: unhex(K.devices.c.pubHex) }, issuedAt: e.delivery.issuedAt, randomness: { ephPriv: unhex(e.ephPrivHex), nonce: unhex(e.nonceHex) } }).sealed)).toBe(e.sealedHex);
    const built = A.buildUmkRotationDelivery({ rotation: V.rotation.fields, deviceId: K.deviceIds.b, devicePubHex: K.devices.b.pubHex, sealed: unhex(x.sealedHex), issuedAt: x.issuedAt, adminRootSeed: unhex(K.adminRoot.seedHex) });
    expect(built.delivery).toEqual(x.delivery);
    expect(built.signatureHex).toBe(x.signatureHex);
  });

  for (const c of V.deliveryCases) {
    it(`delivery: ${c.name}`, () => {
      let p: { umk: Uint8Array } | undefined;
      expect(code(() => (p = A.openUmkRotationDelivery({ rotation: c.rotation, delivery: c.delivery, signatureHex: c.signatureHex, sealed: unhex(c.sealedHex), kind: c.kind, self: c.self, secret: unhex(c.secretHex) })))).toBe(want(c.expect));
      if (c.expect.ok) expect(hex(p!.umk)).toBe(K.newUmkHex);
    });
  }

  for (const c of V.plaintextCases) {
    it(`plaintext: ${c.name}`, () => {
      let p: { umk: Uint8Array; irkScheme: string; adminRootSeed: Uint8Array | null } | undefined;
      expect(code(() => (p = A.decodeUmkRotationPlaintext(unhex(c.hex))))).toBe(want(c.expect));
      if (c.expect.ok) {
        expect([hex(p!.umk), p!.irkScheme, p!.adminRootSeed ? hex(p!.adminRootSeed) : null]).toEqual([c.expect.umkHex, c.expect.irkScheme, c.expect.adminRootSeedHex]);
        expect(hex(A.encodeUmkRotationPlaintext(p!))).toBe(c.hex);
      }
    });
  }

  for (const c of V.keptCases) {
    it(`kept: ${c.name}`, () => {
      expect(code(() => A.verifyKeptDevice({ rotation: V.rotation.fields, kept: c.kept, self: c.self }))).toBe(want(c.expect));
    });
  }

  for (const c of V.derivedCases) {
    it(`derived key: ${c.name}`, () => {
      expect(A.deviceKeyIsUmkDerived(unhex(c.umkHex), c.username, c.deviceId, c.devicePubHex)).toBe(c.derived);
    });
  }
});
