import { describe, expect, it } from "vitest";
import { ed, judgePublisher, signAppRelease, signPublisherRotation, signPublisherTrust, verifyPublisherTrust, type AppRelease, type Keypair, type PublisherPin, type PublisherRotation } from "../src/index.js";

const key = (b: number): Keypair => {
  const privateKey = new Uint8Array(32).fill(b);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const K1 = key(1), K2 = key(2), K3 = key(3);
const release = (over: Partial<AppRelease> = {}): AppRelease => ({ appId: "alice--chess", identityGeneration: 1, version: "1.0.0", packageDigestHex: "a".repeat(40), capabilityDigestHex: "c".repeat(64), keyEpoch: 0, issuedAt: 10, ...over });
const sig = (r: AppRelease, k: Keypair) => signAppRelease(r, k);
const pin = (k: Keypair, epoch = 0): PublisherPin => ({ appId: "alice--chess", identityGeneration: 1, keyHex: hex(k.publicKey), keyEpoch: epoch, firstVerifiedAt: 1 });
const rot = (from: Keypair, to: Keypair, newEpoch: number) => {
  const rotation: PublisherRotation = { appId: "alice--chess", identityGeneration: 1, oldKeyHex: hex(from.publicKey), newKeyHex: hex(to.publicKey), newEpoch, issuedAt: 20 };
  return { rotation, signatureHex: signPublisherRotation(rotation, from) };
};

describe("publisher continuity", () => {
  it("the first verified key is pinned; the same key after that is fine", () => {
    const r = release();
    expect(judgePublisher(null, r, sig(r, K1), hex(K1.publicKey), [], 5)).toMatchObject({ kind: "first-use", pin: { keyHex: hex(K1.publicKey), keyEpoch: 0 } });
    expect(judgePublisher(pin(K1), r, sig(r, K1), hex(K1.publicKey), [], 5)).toEqual({ kind: "same-key" });
  });

  it("a bad signature, a different digest, a different app and a lower epoch are rejected", () => {
    const r = release();
    expect(judgePublisher(pin(K1), r, sig(r, K2), hex(K1.publicKey), [], 5)).toEqual({ kind: "reject", reason: "bad-signature" });
    expect(judgePublisher(pin(K1), r, sig(r, K1), hex(K1.publicKey), [], 5, "b".repeat(40))).toEqual({ kind: "reject", reason: "packaged-for-other-digest" });
    const other = release({ appId: "mallory--chess" });
    expect(judgePublisher(pin(K1), other, sig(other, K1), hex(K1.publicKey), [], 5)).toEqual({ kind: "reject", reason: "wrong-app" });
    const old = release({ keyEpoch: 0 });
    expect(judgePublisher(pin(K1, 3), old, sig(old, K1), hex(K1.publicKey), [], 5)).toEqual({ kind: "reject", reason: "epoch-rollback" });
  });

  it("the same name with a different key is a new identity unless the old key signed the rotation", () => {
    const r = release({ keyEpoch: 1 });
    expect(judgePublisher(pin(K1), r, sig(r, K2), hex(K2.publicKey), [], 5)).toMatchObject({ kind: "new-identity", continuity: "none" });
    const chain = [rot(K1, K2, 1)];
    expect(judgePublisher(pin(K1), r, sig(r, K2), hex(K2.publicKey), chain, 5)).toMatchObject({ kind: "rotated", continuity: "valid-chain", toEpoch: 1 });
  });

  it("a forged, out-of-order, skipped or unrelated chain is not continuity", () => {
    const r = release({ keyEpoch: 1 });
    const forged = rot(K3, K2, 1); // signed by a key that was never the publisher's
    expect(judgePublisher(pin(K1), r, sig(r, K2), hex(K2.publicKey), [forged], 5)).toMatchObject({ kind: "new-identity" });
    const tampered = rot(K1, K2, 1);
    tampered.rotation = { ...tampered.rotation, newKeyHex: hex(K3.publicKey) };
    expect(judgePublisher(pin(K1), r, sig(r, K3), hex(K3.publicKey), [tampered], 5)).toMatchObject({ kind: "new-identity" });
    const skipping = rot(K1, K2, 3);
    expect(judgePublisher(pin(K1), release({ keyEpoch: 3 }), sig(release({ keyEpoch: 3 }), K2), hex(K2.publicKey), [skipping], 5)).toMatchObject({ kind: "new-identity" });
  });

  it("a two-step chain is followed, and a chain that stops short of the signer is not", () => {
    const two = [rot(K1, K2, 1), rot(K2, K3, 2)];
    const r = release({ keyEpoch: 2 });
    expect(judgePublisher(pin(K1), r, sig(r, K3), hex(K3.publicKey), two, 5)).toMatchObject({ kind: "rotated", toEpoch: 2 });
    expect(judgePublisher(pin(K1), r, sig(r, K3), hex(K3.publicKey), [two[0]!], 5)).toMatchObject({ kind: "new-identity" });
  });

  it("a re-created identity (a retired name taken again) inherits nothing", () => {
    const r = release({ identityGeneration: 2 });
    expect(judgePublisher(pin(K1), r, sig(r, K1), hex(K1.publicKey), [], 5)).toEqual({ kind: "reject", reason: "new-generation" });
  });

  it("trust approval is a signature by the owner's device over exactly one service and key change", () => {
    const owner = key(9);
    const t = { serviceId: "alice-chess", appId: "alice--chess", identityGeneration: 1, oldKeyHex: hex(K1.publicKey), newKeyHex: hex(K2.publicKey), newEpoch: 1, issuedAt: 30 };
    const s = signPublisherTrust(t, owner);
    expect(verifyPublisherTrust(t, s, owner.publicKey)).toBe(true);
    expect(verifyPublisherTrust({ ...t, serviceId: "bob-chess" }, s, owner.publicKey)).toBe(false);
    expect(verifyPublisherTrust({ ...t, newKeyHex: hex(K3.publicKey) }, s, owner.publicKey)).toBe(false);
  });
});
