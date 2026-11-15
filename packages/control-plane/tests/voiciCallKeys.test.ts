/**
 * Answering while locked (docs/voici-calls.md, owner decisions 2026-11-15): an admin device binds a call-only key,
 * a locked device joins the room with it, the room takes only that key's answer and end, and a revoked key is gone.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { InMemoryStorage, InMemoryVoiciCallStorage } from "@flagship/storage";
import {
  ed,
  hexToBytes,
  signDeviceCapabilityGrant,
  signVoiciCallEndOwnerWithCallKey,
  signVoiciCallJoin,
  signVoiciCallKeyBinding,
  signVoiciCallKeyRevokeOwner,
  signVoiciCallKeyRevokeSelf,
  type DeviceCapabilityGrant,
} from "@flagship/protocol";
import { authorizeVoiciCallKeyDevice, handleVoiciCallKeyRevoke, VoiciCallRoomCore, type VoiciCallRoomInit } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
const K = V.keys;
const C = V.callKey;
const NOW: number = V.now;
const USER = "alice";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const adminRoot = new Uint8Array(32).fill(51);
const devicePriv = new Uint8Array(32).fill(52);

async function world(o: { admin?: boolean } = {}) {
  const s = Object.assign(new InMemoryStorage(), { voiciCalls: new InMemoryVoiciCallStorage() });
  await s.usernames.put({ username: USER, irkPubHex: "11".repeat(32), aidPubHex: "22".repeat(32), claimedAt: 1, adminRootPubHex: hex(ed.getPublicKey(adminRoot)) });
  if (o.admin !== false) {
    const grant: DeviceCapabilityGrant = { grantId: "g-1", username: USER, deviceId: C.deviceId, devicePubKey: ed.getPublicKey(devicePriv), scopes: ["admin"], issuedAt: NOW - 1000, expiresAt: NOW + 10_000_000 };
    await s.deviceCapabilityGrants.put({
      grantId: grant.grantId,
      username: USER,
      deviceId: grant.deviceId,
      devicePubHex: hex(grant.devicePubKey),
      scopesJson: JSON.stringify(grant.scopes),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(signDeviceCapabilityGrant(grant, { privateKey: adminRoot, publicKey: ed.getPublicKey(adminRoot) })),
      revokedAt: null,
      signerRoot: "admin-root",
    });
  }
  await s.voici.publishPage({ username: USER, pageId: K.pageId, seq: 1, issuedAt: NOW, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: "{}", publishedAt: NOW }, 0);
  await s.voiciCalls.putCallKey({ ...C.binding.binding, signature: C.binding.signature, registeredAt: NOW });
  const deps = { voici: s.voici, calls: s.voiciCalls, usernames: s.usernames, grants: s.deviceCapabilityGrants, now: () => NOW };
  return { s, deps };
}

const callId: string = V.request.signed.callId;
const joinAt = (at = NOW, priv = hexToBytes(C.priv), pub: string = C.pub, deviceId: string = C.deviceId) => ({
  deviceId,
  callKeyPub: pub,
  issuedAt: at,
  signature: signVoiciCallJoin({ username: USER, callId, deviceId, callKeyPub: pub, issuedAt: at }, priv),
});

describe("call keys on .com", () => {
  it("a locked admin device joins with its bound call key; deviceRef is the key's", async () => {
    const w = await world();
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt())).toEqual({ deviceRef: C.answer.deviceRef, callKeyPub: C.pub });
  });

  it("refuses a stale join, another key, a device that is not an admin, and a key bound under another page key", async () => {
    const w = await world();
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt(NOW - 11 * 60_000))).toBeNull();
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt(NOW, hexToBytes(C.otherPriv), C.otherPub))).toBeNull();
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt(NOW, hexToBytes(C.priv), C.pub, "d2".repeat(16)))).toBeNull();
    expect(await authorizeVoiciCallKeyDevice((await world({ admin: false })).deps, USER, callId, joinAt())).toBeNull();
    const rotated = await world();
    await rotated.s.voici.publishPage({ username: USER, pageId: K.pageId, seq: 2, issuedAt: NOW, acceptsMessages: 1, inboxEpoch: 2, ownerSignPub: hex(ed.getPublicKey(new Uint8Array(32).fill(9))), indexJson: "{}", publishedAt: NOW }, 1);
    expect(await authorizeVoiciCallKeyDevice(rotated.deps, USER, callId, joinAt())).toBeNull();
  });

  it("a revocation by the owner key or the call key itself ends it, and the key never binds again", async () => {
    for (const sign of [(r: never) => signVoiciCallKeyRevokeOwner(r, hexToBytes(K.ownerSignSeed)), (r: never) => signVoiciCallKeyRevokeSelf(r, hexToBytes(C.priv))]) {
      const w = await world();
      const revoke = { username: USER, deviceId: C.deviceId, callKeyPub: C.pub, revokedAt: NOW };
      const bad = await handleVoiciCallKeyRevoke(w.deps, USER, { revoke, signature: signVoiciCallKeyRevokeSelf(revoke, hexToBytes(C.otherPriv)) });
      expect(bad.status).toBe(403);
      const r = await handleVoiciCallKeyRevoke(w.deps, USER, { revoke, signature: sign(revoke as never) });
      expect(r.status).toBe(200);
      expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt())).toBeNull();
      expect(await w.s.voiciCalls.putCallKey({ ...C.binding.binding, signature: C.binding.signature, registeredAt: NOW })).toBe(false);
    }
  });

  it("a fresh binding replaces the device's previous key", async () => {
    const w = await world();
    const priv = new Uint8Array(32).fill(0x73);
    const pub = hex(p256.getPublicKey(priv, false));
    const proof = signVoiciCallKeyBinding({ username: USER, deviceId: C.deviceId, callKeyPub: pub, createdAt: NOW }, hexToBytes(K.ownerSignSeed));
    expect(await w.s.voiciCalls.putCallKey({ ...proof.binding, signature: proof.signature, registeredAt: NOW })).toBe(true);
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt())).toBeNull();
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt(NOW, priv, pub))).not.toBeNull();
  });
});

describe("the room with a call-key device", () => {
  const init: VoiciCallRoomInit = {
    callId,
    username: USER,
    pageId: K.pageId,
    ownerSignPub: K.ownerSignPub,
    inboxPub: V.pageV2.signed.inboxPub,
    request: V.request.signed,
    callerPub: K.browserPub,
    callerTokenHash: "00".repeat(32),
    ringingAt: V.t0 + 1_000,
  };
  const ca = { seed: hexToBytes(K.caSeed) };
  const peer = { role: "device" as const, deviceRef: C.answer.deviceRef, callKeyPub: C.pub };

  it("takes the call key's answer and its end; refuses an owner-signed answer from that peer", () => {
    const refused = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(refused.message(peer, { t: "answer", answer: V.answer.signed }, NOW)).toEqual([{ kind: "send", to: { deviceRef: peer.deviceRef }, msg: { t: "error", code: "bad-signature" } }]);
    const room = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    const won = room.message(peer, { t: "answer", answer: C.answer.signed }, NOW);
    expect(won[0]).toMatchObject({ kind: "send", to: { deviceRef: peer.deviceRef }, msg: { t: "won" } });
    expect(room.state.winnerCallKeyPub).toBe(C.pub);
    const end = signVoiciCallEndOwnerWithCallKey({ callId, reason: "hangup", issuedAt: NOW }, hexToBytes(C.priv));
    const otherEnd = signVoiciCallEndOwnerWithCallKey({ callId, reason: "hangup", issuedAt: NOW }, hexToBytes(C.otherPriv));
    expect(room.message(peer, { t: "end", end: otherEnd }, NOW)).toEqual([]);
    expect(room.message(peer, { t: "end", end }, NOW).map((a) => a.kind)).toEqual(["send", "send", "release", "close-all"]);
  });

  it("a device that joined with its account key can't present a call-key answer as its own", () => {
    const room = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(room.message({ role: "device", deviceRef: K.deviceRef }, { t: "answer", answer: C.answer.signed }, NOW)).toEqual([
      { kind: "send", to: { deviceRef: K.deviceRef }, msg: { t: "error", code: "wrong-device" } },
    ]);
  });
});

describe("review-cloud: call-key revocation is scoped to the account that bound the key", () => {
  it("review-cloud: another account's owner key cannot revoke alice's call key (cross-account DoS)", async () => {
    const w = await world();
    // Mallory has her own voi.ci page and owner messages key; alice's callKeyPub is public (every answer carries it).
    const mallorySeed = new Uint8Array(32).fill(0x6d);
    await w.s.voici.publishPage(
      { username: "mallory", pageId: "6d".repeat(16), seq: 1, issuedAt: NOW, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: hex(ed.getPublicKey(mallorySeed)), indexJson: "{}", publishedAt: NOW },
      0,
    );
    const revoke = { username: "mallory", deviceId: "6d".repeat(16), callKeyPub: C.pub, revokedAt: NOW };
    await handleVoiciCallKeyRevoke(w.deps, "mallory", { revoke, signature: signVoiciCallKeyRevokeOwner(revoke, mallorySeed) });
    // Alice's locked device must still be able to join with her own, never-revoked key.
    expect(await authorizeVoiciCallKeyDevice(w.deps, USER, callId, joinAt())).not.toBeNull();
  });
});
