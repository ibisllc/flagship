import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AccountKeyRotationError,
  PqTrustError,
  accountKeyRotationDigestHex,
  buildUmkRotationDelivery,
  canonicalAccountKeyRotation,
  canonicalAccountKeyRotationV2,
  canonicalCgkRekey,
  canonicalDeviceKeyRotate,
  canonicalDeviceReceiveKey,
  canonicalLuksRekeyConfirm,
  canonicalSwkRekey,
  canonicalUmkRotationDelivery,
  decodeUmkRotationPlaintext,
  deviceKeyIsUmkDerived,
  ed,
  encodeUmkRotationPlaintext,
  hybridSealKeygen,
  keptDevicesDigestHex,
  keptDevicesLines,
  legacyPolicyState,
  openUmkRotationDelivery,
  pqBindingKeyIdHex,
  sealUmkRotation,
  signAccountKeyRotation,
  signAccountKeyRotationPq,
  signDeviceKeyRotate,
  signDeviceReceiveKey,
  verifyAccountKeyRotation,
  verifyAccountKeyRotationChain,
  verifyAccountKeyRotationPq,
  verifyDeviceKeyRotate,
  verifyDeviceReceiveKey,
  verifyKeptDevice,
  verifyPqKeyBinding,
  verifyRekey,
  type PolicyState,
  type VerifiedPqKeyBinding,
} from "../src/index.js";

const V = JSON.parse(readFileSync(resolve(__dirname, "../test-vectors/account-key-rotation/vectors.json"), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const kp = (seedHex: string) => ({ privateKey: unhex(seedHex), publicKey: ed.getPublicKey(unhex(seedHex)) });
const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof AccountKeyRotationError || e instanceof PqTrustError) return e.code;
    return `other:${String(e)}`;
  }
};
const want = (e: { ok: boolean; code?: string }) => (e.ok ? "ok" : e.code);
const verified = (name: string | null): VerifiedPqKeyBinding | null => {
  if (name === null) return null;
  const w = V.bindings[name];
  return verifyPqKeyBinding(w, { role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: V.now });
};
const policy = (p: { profile: string; rollout: string }): PolicyState => ({
  ...legacyPolicyState({ kind: "installation", id: "home.alice.flagship.services" }),
  profile: p.profile as PolicyState["profile"],
  rollout: p.rollout as PolicyState["rollout"],
});
const STRICT = policy({ profile: "strict", rollout: "enforced" });

describe("account-key-rotation vectors", () => {
  it("builds every canonical form and digest", () => {
    expect(utf8(canonicalAccountKeyRotation(V.rotation.fields))).toBe(V.rotation.canonical);
    expect(accountKeyRotationDigestHex(V.rotation.fields)).toBe(V.rotation.digestHex);
    expect(keptDevicesLines(V.keptDevices.list)).toBe(V.keptDevices.lines);
    expect(keptDevicesDigestHex(V.keptDevices.list)).toBe(V.keptDevices.digestHex);
    expect(V.rotation.fields.keptDevicesDigestHex).toBe(V.keptDevices.digestHex);
    expect(pqBindingKeyIdHex(V.bindings.newIrk)).toBe(V.pq.newIrkKeyIdHex);
    expect(utf8(canonicalAccountKeyRotationV2(V.rotation.fields, V.pq.newIrkKeyIdHex))).toBe(V.pq.canonicalV2);
    for (const k of ["xwing", "ed25519"]) expect(utf8(canonicalUmkRotationDelivery(V.delivery[k].delivery))).toBe(V.delivery[k].canonical);
    expect(utf8(canonicalDeviceKeyRotate(V.deviceKeyRotate.fields))).toBe(V.deviceKeyRotate.canonical);
    expect(utf8(canonicalDeviceReceiveKey(V.deviceReceiveKey.fields))).toBe(V.deviceReceiveKey.canonical);
    expect(utf8(canonicalCgkRekey(V.cgkRekey.fields))).toBe(V.cgkRekey.canonical);
    expect(utf8(canonicalSwkRekey(V.swkRekey.fields))).toBe(V.swkRekey.canonical);
    expect(utf8(canonicalLuksRekeyConfirm(V.luksRekeyConfirm.fields))).toBe(V.luksRekeyConfirm.canonical);
  });

  it("re-signs the hop and every small envelope byte for byte", () => {
    const k = V.keys;
    expect(signAccountKeyRotation(V.rotation.fields, { adminRoot: kp(k.adminRoot.seedHex), newIrk: kp(k.newIrk.seedHex), newAid: kp(k.newAid.seedHex) })).toEqual(V.rotation.signatures);
    expect(signDeviceKeyRotate(V.deviceKeyRotate.fields, { newKey: kp(k.devices.eNew.seedHex), adminRoot: kp(k.adminRoot.seedHex) })).toEqual({
      newKeySignatureHex: V.deviceKeyRotate.newKeySignatureHex,
      adminRootSignatureHex: V.deviceKeyRotate.adminRootSignatureHex,
    });
    expect(signDeviceReceiveKey(V.deviceReceiveKey.fields, kp(k.devices.b.seedHex))).toBe(V.deviceReceiveKey.signatureHex);
    const secret = new Uint8Array([...unhex(k.adminRoot.seedHex), ...unhex(k.adminRoot.mldsaSeedHex)]);
    expect(signAccountKeyRotationPq(V.rotation.fields, secret, V.bindings.newIrk, { deterministic: true }).signature).toEqual(V.pqSignatures.adminRoot);
  });

  it("verifies the small envelopes and refuses the wrong signer", () => {
    const k = V.keys;
    const dkr = V.deviceKeyRotate;
    const sigs = { newKeySignatureHex: dkr.newKeySignatureHex, adminRootSignatureHex: dkr.adminRootSignatureHex };
    expect(verifyDeviceKeyRotate(dkr.fields, sigs, k.adminRoot.pubHex)).toBe(true);
    expect(verifyDeviceKeyRotate(dkr.fields, sigs, k.other.pubHex)).toBe(false);
    expect(verifyDeviceKeyRotate({ ...dkr.fields, newDevicePubHex: dkr.fields.oldDevicePubHex }, sigs, k.adminRoot.pubHex)).toBe(false);
    expect(verifyDeviceReceiveKey(V.deviceReceiveKey.fields, V.deviceReceiveKey.signatureHex)).toBe(true);
    expect(verifyDeviceReceiveKey({ ...V.deviceReceiveKey.fields, deviceId: k.deviceIds.c }, V.deviceReceiveKey.signatureHex)).toBe(false);
    const pubOf = (s: string) => (s === "newIrk" ? k.newIrk.pubHex : k.adminRoot.pubHex);
    for (const [name, build] of [["cgkRekey", canonicalCgkRekey], ["swkRekey", canonicalSwkRekey], ["luksRekeyConfirm", canonicalLuksRekeyConfirm]] as const) {
      const e = V[name];
      expect(verifyRekey(() => (build as (f: unknown) => Uint8Array)(e.fields), e.signatureHex, pubOf(e.signer))).toBe(true);
      expect(verifyRekey(() => (build as (f: unknown) => Uint8Array)({ ...e.fields, toEpoch: 2 }), e.signatureHex, pubOf(e.signer))).toBe(false);
      expect(verifyRekey(() => (build as (f: unknown) => Uint8Array)(e.fields), e.signatureHex, k.other.pubHex)).toBe(false);
    }
  });

  for (const c of V.hopCases) {
    it(`hop: ${c.name}`, () => {
      expect(code(() => verifyAccountKeyRotation({ rotation: c.rotation, signatures: c.signatures, state: c.state }))).toBe(want(c.expect));
    });
  }

  for (const c of V.pqCases) {
    it(`companion: ${c.name}`, () => {
      const pq = c.signature === null ? null : { signature: V.pqSignatures[c.signature], newIrkBinding: V.bindings[c.binding] };
      expect(code(() => verifyAccountKeyRotationPq({ rotation: V.rotation.fields, pq, adminRootBinding: verified(c.adminRootBinding), policy: policy(c.policy), now: V.now }))).toBe(want(c.expect));
    });
  }

  for (const c of V.chainCases) {
    it(`chain: ${c.name}`, () => {
      const events = c.events.map((n: string) => V.chainEvents[n]);
      const pq = c.strict ? { policy: STRICT, adminRootBinding: verified("adminRoot"), now: V.now } : undefined;
      let result: ReturnType<typeof verifyAccountKeyRotationChain> | undefined;
      const got = code(() => {
        result = verifyAccountKeyRotationChain({ start: V.chainStart, events, pq });
      });
      expect(got).toBe(c.expect.ok ? "ok" : c.expect.code);
      if (c.expect.ok) {
        expect(result!.applied).toBe(c.expect.applied);
        expect(result!.state).toEqual(c.expect.state);
        if (c.strict) {
          expect(result!.irkBinding?.ed25519PubHex).toBe(c.expect.state.irkPubHex);
          expect(result!.adminRootBinding?.ed25519PubHex).toBe(c.expect.state.adminRootPubHex);
        }
      }
    });
  }

  it("re-seals the X-Wing delivery byte for byte and rebuilds both deliveries", () => {
    const x = V.delivery.xwing;
    const recv = hybridSealKeygen(unhex(V.keys.bReceive.seedHex));
    expect(hex(recv.publicKey)).toBe(V.keys.bReceive.pubHex);
    const s = sealUmkRotation({ rotation: V.rotation.fields, deviceId: V.keys.deviceIds.b, plaintext: unhex(x.plaintextHex), recipient: { kind: "xwing", publicKey: recv.publicKey }, issuedAt: x.issuedAt, randomness: { xwing: unhex(x.randomnessHex) } });
    expect(hex(s.sealed)).toBe(x.sealedHex);
    const e = V.delivery.ed25519;
    const s2 = sealUmkRotation({ rotation: V.rotation.fields, deviceId: V.keys.deviceIds.c, plaintext: unhex(e.plaintextHex), recipient: { kind: "ed25519", devicePub: unhex(V.keys.devices.c.pubHex) }, issuedAt: e.delivery.issuedAt, randomness: { ephPriv: unhex(e.ephPrivHex), nonce: unhex(e.nonceHex) } });
    expect(hex(s2.sealed)).toBe(e.sealedHex);
    for (const [d, id, pub] of [[x, "b", V.keys.devices.b.pubHex], [e, "c", V.keys.devices.c.pubHex]] as const) {
      const built = buildUmkRotationDelivery({ rotation: V.rotation.fields, deviceId: V.keys.deviceIds[id], devicePubHex: pub, sealed: unhex(d.sealedHex), issuedAt: d.delivery.issuedAt, adminRoot: kp(V.keys.adminRoot.seedHex) });
      expect(built.delivery).toEqual(d.delivery);
      expect(built.signatureHex).toBe(d.signatureHex);
    }
  });

  for (const c of V.deliveryCases) {
    it(`delivery: ${c.name}`, () => {
      let opened: ReturnType<typeof openUmkRotationDelivery> | undefined;
      const got = code(() => {
        opened = openUmkRotationDelivery({ rotation: c.rotation, delivery: c.delivery, signatureHex: c.signatureHex, sealed: unhex(c.sealedHex), kind: c.kind, self: c.self, secret: unhex(c.secretHex) });
      });
      expect(got).toBe(want(c.expect));
      if (c.expect.ok) expect(hex(opened!.umk)).toBe(V.keys.newUmkHex);
    });
  }

  for (const c of V.plaintextCases) {
    it(`plaintext: ${c.name}`, () => {
      let p: ReturnType<typeof decodeUmkRotationPlaintext> | undefined;
      expect(code(() => (p = decodeUmkRotationPlaintext(unhex(c.hex))))).toBe(want(c.expect));
      if (c.expect.ok) {
        expect(hex(p!.umk)).toBe(c.expect.umkHex);
        expect(p!.irkScheme).toBe(c.expect.irkScheme);
        expect(p!.adminRootSeed ? hex(p!.adminRootSeed) : null).toBe(c.expect.adminRootSeedHex);
        expect(hex(encodeUmkRotationPlaintext(p!))).toBe(c.hex);
      }
    });
  }

  for (const c of V.keptCases) {
    it(`kept: ${c.name}`, () => {
      expect(code(() => verifyKeptDevice({ rotation: V.rotation.fields, kept: c.kept, self: c.self }))).toBe(want(c.expect));
    });
  }

  for (const c of V.derivedCases) {
    it(`derived key: ${c.name}`, () => {
      expect(deviceKeyIsUmkDerived(unhex(c.umkHex), c.username, c.deviceId, c.devicePubHex)).toBe(c.derived);
    });
  }

  it("refuses malformed fields at encode time", () => {
    const f = V.rotation.fields;
    expect(() => canonicalAccountKeyRotation({ ...f, username: "Alice" })).toThrow();
    expect(() => canonicalAccountKeyRotation({ ...f, removedDeviceIds: [f.removedDeviceIds[0], f.removedDeviceIds[0]] })).toThrow();
    expect(() => canonicalAccountKeyRotation({ ...f, newIrkScheme: "mac" })).toThrow();
    expect(() => canonicalAccountKeyRotation({ ...f, fromEpoch: 1.5 })).toThrow();
    expect(() => keptDevicesLines([...V.keptDevices.list, V.keptDevices.list[0]])).toThrow();
    expect(() => canonicalCgkRekey({ ...V.cgkRekey.fields, serverDomain: "Home.example" })).toThrow();
    expect(utf8(canonicalAccountKeyRotation({ ...f, removedDeviceIds: [], recoveryRecordDigestHex: null }))).toContain("|none|" + f.keptDevicesDigestHex + "|none|");
  });
});
