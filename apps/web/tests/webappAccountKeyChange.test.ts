// The webapp's account-key change (lib/accountKeyChange.js): the rotator's request is checked with the
// TypeScript protocol (the same code `.com` and the boxes run), the receiver replays the lane and opens its own
// delivery, the pending slot promotes or drops, the receive key and the device-key move are well signed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as P from "@flagship/protocol";
import * as C from "../public/webapp/lib/accountKeyChange.js";
import * as A from "../public/webapp/lib/accountKeyRotation.js";
import { hybridSealKeygen } from "../public/webapp/lib/voiciCore.js";
import { deviceGrantCanonicalBytes } from "../public/webapp/lib/crossDevicePairing.js";
import { adminRootRotationCanonicalBytes } from "../public/webapp/lib/adminRootRotation.js";
import { ed25519, hkdf, sha256 } from "../public/webapp/vendor/noble-post-quantum/pq-seal.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const pub = (seed: Uint8Array) => hex(ed25519.getPublicKey(seed));
const seed = (n: number) => new Uint8Array(32).fill(n);
const U = "alice";

const OLD_UMK = seed(1);
const ROOT = seed(2);
const SELF_ID = "a".repeat(32);
const PHONE_ID = "b".repeat(32);
const LOST_ID = "c".repeat(32);
const DERIVED_ID = "d".repeat(32);
const SELF_SEED = seed(3);
const PHONE_SEED = seed(4);
const LOST_SEED = seed(5);
const PHONE_RECEIVE = seed(6);
const derivedSeedOf = (umk: Uint8Array, id: string) => hkdf(sha256, umk, new Uint8Array(0), new TextEncoder().encode(`flagship/account-device-key/v1|${U}|${id}`), 32);
const derivedPub = (umk: Uint8Array, id: string) => pub(derivedSeedOf(umk, id));

const grantFor = (id: string, devicePub: string, scopes: string[], signerRoot: "admin-root" | "membership") => ({
  grantId: "11111111-2222-4333-8444-555555555555", deviceId: id, devicePubHex: devicePub, scopesJson: JSON.stringify(scopes), signerRoot, revokedAt: null,
});

function receiveKeyRecord(id: string, deviceSeed: Uint8Array, receiveSeed: Uint8Array) {
  const k = { username: U, deviceId: id, devicePubHex: pub(deviceSeed), xwingPubHex: hex(hybridSealKeygen(receiveSeed).publicKey), issuedAt: 1000 };
  return { ...k, accountId: U, signatureHex: A.signDeviceReceiveKey(k, deviceSeed) };
}

function directory(extra: { lostScopes?: string[]; withDerived?: boolean; phoneReceive?: boolean } = {}) {
  const devices = [
    { deviceId: SELF_ID, devicePubHex: pub(SELF_SEED), platformClass: "web", createdAt: 1, revokedAt: null, grant: grantFor(SELF_ID, pub(SELF_SEED), ["browse", "admin", "view-directory"], "admin-root"), selfDisplayName: "Laptop" },
    { deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED), platformClass: "ios", createdAt: 2, revokedAt: null, grant: grantFor(PHONE_ID, pub(PHONE_SEED), ["browse", "view-directory"], "membership"), managedDisplayName: "Kid's phone" },
    { deviceId: LOST_ID, devicePubHex: pub(LOST_SEED), platformClass: "android", createdAt: 3, revokedAt: null, grant: grantFor(LOST_ID, pub(LOST_SEED), extra.lostScopes ?? ["browse", "view-directory"], "membership") },
  ];
  if (extra.withDerived) devices.push({ deviceId: DERIVED_ID, devicePubHex: derivedPub(OLD_UMK, DERIVED_ID), platformClass: "web", createdAt: 4, revokedAt: null, grant: null } as never);
  return {
    accountId: U,
    accountDisplayName: "The Smiths",
    accountProfile: { revision: 3 },
    devices,
    selfProfiles: [],
    managedProfiles: [{ deviceId: PHONE_ID, revision: 1, locked: false }],
    receiveKeys: extra.phoneReceive === false ? [] : [receiveKeyRecord(PHONE_ID, PHONE_SEED, PHONE_RECEIVE)],
  };
}

const oldIrkSeed = A.deriveIrkSeedInScheme(OLD_UMK, "web", 1);
const oldAidSeed = A.deriveAidSeed(OLD_UMK);
const account = { username: U, keyEpoch: 0, irkPubHex: pub(oldIrkSeed), aidPubHex: pub(oldAidSeed) };
const state = (root = pub(ROOT)) => ({ username: U, epoch: 0, irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, adminRootPubHex: root });

describe("planning who keeps the account", () => {
  it("keeps the others, leaves out a derived key, removes the lost device", () => {
    const plan = C.planRotation({ username: U, directory: directory({ withDerived: true }), removedDeviceId: LOST_ID, selfDeviceId: SELF_ID, umk: OLD_UMK });
    expect(plan.kept.map((k: { device: { deviceId: string } }) => k.device.deviceId).sort()).toEqual([SELF_ID, PHONE_ID].sort());
    expect(plan.excluded).toEqual([expect.objectContaining({ reason: "derived" })]);
    expect(plan.removed.deviceId).toBe(LOST_ID);
    expect(plan.removedHeldAdmin).toBe(false);
  });

  it("under strict, a device with no receive key is added again instead", () => {
    const plan = C.planRotation({ username: U, directory: directory({ phoneReceive: false }), removedDeviceId: LOST_ID, selfDeviceId: SELF_ID, umk: OLD_UMK, strict: true });
    expect(plan.excluded).toEqual([expect.objectContaining({ reason: "no-receive-key" })]);
  });

  it("refuses while this browser's own key is still derived", () => {
    const d = directory();
    d.devices[0]!.devicePubHex = derivedPub(OLD_UMK, SELF_ID);
    expect(() => C.planRotation({ username: U, directory: d, removedDeviceId: LOST_ID, selfDeviceId: SELF_ID, umk: OLD_UMK })).toThrow(expect.objectContaining({ code: "self-derived" }));
  });

  it("a receive key signed by another key is not used", () => {
    const d = directory();
    d.receiveKeys[0]!.signatureHex = A.signDeviceReceiveKey({ username: U, deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED), xwingPubHex: d.receiveKeys[0]!.xwingPubHex, issuedAt: 1000 }, LOST_SEED);
    expect(C.verifiedReceiveKey(U, d.devices[1], d.receiveKeys)).toBeNull();
  });
});

async function built(opts: { lostScopes?: string[] } = {}) {
  const dir = directory({ ...opts, withDerived: true });
  const plan = C.planRotation({ username: U, directory: dir, removedDeviceId: LOST_ID, selfDeviceId: SELF_ID, umk: OLD_UMK });
  const out = await C.buildRotationRequest({ plan, account, adminRootSeed: ROOT, directory: dir, now: Date.now(), newUmk: seed(9), newRootSeed: seed(10) });
  return { dir, plan, out };
}

describe("the rotator's request", () => {
  it("is a hop the protocol accepts, for the kept list it names", async () => {
    const { out } = await built();
    const r = out.body.rotation;
    expect(() => P.verifyAccountKeyRotation({ rotation: r, signatures: out.body.signatures, state: state() })).not.toThrow();
    expect(r.keptDevicesDigestHex).toBe(P.keptDevicesDigestHex(out.body.kept));
    expect(r.removedDeviceIds.sort()).toEqual([LOST_ID, DERIVED_ID].sort());
    expect(r.newIrkPubHex).toBe(C.rotatedKeysOf(seed(9)).irkPubHex);
    expect(r.recoveryRecordDigestHex).toBeNull();
    expect(out.body.adminRootRotation).toBeUndefined();
  });

  it("seals the phone's delivery with X-Wing, and it opens to the new key", async () => {
    const { out } = await built();
    expect(out.body.deliveries).toHaveLength(1);
    const d = out.body.deliveries[0];
    expect(d.sealKind).toBe("xwing");
    expect(ed25519.verify(unhex(d.signatureHex), P.canonicalUmkRotationDelivery(d.delivery), unhex(pub(ROOT)))).toBe(true);
    const p = C.openDeliveryForHop({ rotation: out.body.rotation, deliveries: [{ toEpoch: 1, ...d }], self: { deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED) }, secrets: { receiveSeed: PHONE_RECEIVE, deviceSeed: PHONE_SEED } });
    expect(hex(p.umk)).toBe(hex(seed(9)));
    expect(p.adminRootSeed).toBeNull();
  });

  it("falls back to the Ed25519 seal outside strict when a device has no receive key", async () => {
    const dir = directory({ phoneReceive: false });
    const plan = C.planRotation({ username: U, directory: dir, removedDeviceId: LOST_ID, selfDeviceId: SELF_ID, umk: OLD_UMK });
    const { body } = await C.buildRotationRequest({ plan, account, adminRootSeed: ROOT, directory: dir, newUmk: seed(9) });
    expect(body.deliveries[0].sealKind).toBe("ed25519");
    const p = C.openDeliveryForHop({ rotation: body.rotation, deliveries: [{ toEpoch: 1, ...body.deliveries[0] }], self: { deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED) }, secrets: { deviceSeed: PHONE_SEED } });
    expect(hex(p.umk)).toBe(hex(seed(9)));
  });

  it("gives the phone an admin-root grant for its membership one, same scopes", async () => {
    const { out } = await built();
    expect(out.body.grants).toHaveLength(1);
    const g = out.body.grants[0];
    expect(g.signerRoot).toBe("admin-root");
    expect(g.grant.scopes).toEqual(["browse", "view-directory"]);
    const bytes = deviceGrantCanonicalBytes({ ...g.grant, devicePubHex: g.grant.devicePubKey });
    expect(ed25519.verify(unhex(g.signature), bytes, unhex(pub(ROOT)))).toBe(true);
    expect(P.verifyDeviceCapabilityGrant({ ...g.grant, devicePubKey: unhex(g.grant.devicePubKey) }, unhex(g.signature), unhex(pub(ROOT)))).toBe(true);
  });

  it("re-encrypts the account name and the managed device name under the new key", async () => {
    const { out } = await built();
    expect(out.body.accountProfile.revision).toBe(4);
    expect(P.verifyAccountProfile(out.body.accountProfile, unhex(pub(ROOT)))).toBe(true);
    const key = await (await import("../public/webapp/lib/accountMetadata.js")).deriveAccountProfileKey(seed(9));
    const { decryptProfile } = await import("../public/webapp/lib/accountMetadata.js");
    expect(await decryptProfile({ ...out.body.accountProfile, recordType: "account-profile" }, key)).toBe("The Smiths");
    expect(out.body.managedProfiles).toHaveLength(1);
    expect(out.body.managedProfiles[0].revision).toBe(2);
  });

  it("changes the admin root first when the removed device held the admin scope", async () => {
    const { out } = await built({ lostScopes: ["browse", "admin", "view-directory"] });
    const ar = out.body.adminRootRotation;
    expect(ar.rotation.oldAdminRootPub).toBe(pub(ROOT));
    expect(ar.rotation.newAdminRootPub).toBe(pub(seed(10)));
    expect(ed25519.verify(unhex(ar.signatureHex), adminRootRotationCanonicalBytes(ar.rotation), unhex(pub(ROOT)))).toBe(true);
    expect(out.body.rotation.adminRootPubHex).toBe(pub(seed(10)));
    expect(() => P.verifyAccountKeyRotation({ rotation: out.body.rotation, signatures: out.body.signatures, state: state(pub(seed(10))) })).not.toThrow();
    expect(out.newAdminRootSeed).toEqual(seed(10));
  });
});

function laneFor(body: any, extra: any[] = []) {
  return [...extra, { kind: "account-key-rotation", rotation: body.rotation, signatures: body.signatures, kept: body.kept }];
}

describe("the receiver's checks", () => {
  const phone = { deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED) };

  it("accepts the hop from its own key under the pinned root", async () => {
    const { out } = await built();
    const v = C.verifyLaneForDevice({ username: U, lane: laneFor(out.body), pinnedRoot: pub(ROOT), irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, self: phone });
    expect(v.hops).toHaveLength(1);
  });

  it("refuses a hop signed by a root it never pinned", async () => {
    const { out } = await built();
    expect(() => C.verifyLaneForDevice({ username: U, lane: laneFor(out.body), pinnedRoot: pub(seed(42)), irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, self: phone })).toThrow(expect.objectContaining({ code: "wrong-admin-root" }));
  });

  it("follows an admin-root rotation the pinned root signed", async () => {
    const { out } = await built({ lostScopes: ["admin"] });
    const ar = out.body.adminRootRotation;
    const event = { kind: "admin-root-rotation", seq: 1, rotation: { username: U, oldAdminRootPubHex: ar.rotation.oldAdminRootPub, newAdminRootPubHex: ar.rotation.newAdminRootPub, issuedAt: ar.rotation.issuedAt }, signatureHex: ar.signatureHex };
    const v = C.verifyLaneForDevice({ username: U, lane: laneFor(out.body, [event]), pinnedRoot: pub(ROOT), irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, self: phone });
    expect(v.adminRootPubHex).toBe(pub(seed(10)));
    expect(v.hops).toHaveLength(1);
  });

  it("ignores an admin-root rotation the pinned root did not sign", async () => {
    const { out } = await built({ lostScopes: ["admin"] });
    const forged = { kind: "admin-root-rotation", rotation: { username: U, oldAdminRootPubHex: pub(ROOT), newAdminRootPubHex: pub(seed(10)), issuedAt: 1 }, signatureHex: "00".repeat(64) };
    expect(() => C.verifyLaneForDevice({ username: U, lane: laneFor(out.body, [forged]), pinnedRoot: pub(ROOT), irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, self: phone })).toThrow(expect.objectContaining({ code: "wrong-admin-root" }));
  });

  it("says not-kept when the hop leaves this device out", async () => {
    const { out } = await built();
    const lost = { deviceId: LOST_ID, devicePubHex: pub(LOST_SEED) };
    expect(() => C.verifyLaneForDevice({ username: U, lane: laneFor(out.body), pinnedRoot: pub(ROOT), irkPubHex: account.irkPubHex, aidPubHex: account.aidPubHex, self: lost })).toThrow(expect.objectContaining({ code: "not-kept" }));
  });

  it("refuses a delivery whose key does not derive the hop's IRK", async () => {
    const { out } = await built();
    const r = out.body.rotation;
    const plaintext = A.encodeUmkRotationPlaintext({ umk: seed(77), irkScheme: "web" });
    const sealed = A.sealUmkRotation({ rotation: r, deviceId: PHONE_ID, plaintext, recipient: { kind: "xwing", publicKey: hybridSealKeygen(PHONE_RECEIVE).publicKey }, issuedAt: 5 });
    const bad = A.buildUmkRotationDelivery({ rotation: r, deviceId: PHONE_ID, devicePubHex: pub(PHONE_SEED), sealed: sealed.sealed, issuedAt: 5, adminRootSeed: ROOT });
    expect(() => C.openDeliveryForHop({ rotation: r, deliveries: [{ toEpoch: 1, ...bad, sealKind: "xwing", sealedHex: hex(sealed.sealed) }], self: phone, secrets: { receiveSeed: PHONE_RECEIVE, deviceSeed: PHONE_SEED } })).toThrow(expect.objectContaining({ code: "umk-mismatch" }));
  });
});

/** Fake keystore + `.com` for the IO paths. */
function harness(opts: { comIrk?: string; deliveries?: any[]; lane?: any[]; postStatus?: number; pending?: any } = {}) {
  const calls: string[] = [];
  const store = { pending: opts.pending ?? null as any, installed: [] as any[], deviceSeeds: new Map<string, Uint8Array>(), receive: null as any, adoptedScheme: null as any, acked: [] as number[] };
  const session: any = { umk: OLD_UMK, irk: { publicKey: unhex(account.irkPubHex) }, username: U, adminRootSeed: ROOT };
  const profile = { accountId: U, deviceId: PHONE_ID };
  const deps: any = {
    deriveAccountDeviceSeed: async () => PHONE_SEED,
    loadReceiveKeySeed: async () => store.receive,
    persistReceiveKeySeed: async (_u: any, _a: any, _d: any, s: Uint8Array, publishedFor: string | null) => { store.receive = { seed: s, publishedFor }; },
    persistAccountDeviceSeed: async (umk: Uint8Array, _a: string, id: string, s: Uint8Array) => { store.deviceSeeds.set(`${hex(umk)}|${id}`, s); },
    persistAdminRootSeed: async () => { calls.push("admin-root"); },
    installSuccessorUmk: async (o: Uint8Array, n: Uint8Array, e: number) => { store.installed.push({ o: hex(o), n: hex(n), e }); },
    putPendingRotation: async (_u: Uint8Array, p: any) => { store.pending = p; },
    loadPendingRotation: async () => store.pending,
    clearPendingRotation: async () => { store.pending = null; calls.push("clear-pending"); },
    adoptRegisteredIrk: (k: any) => { store.adoptedScheme = k; },
    unlockSession: async (umk: Uint8Array) => { session.umk = umk; session.irk = { publicKey: unhex(C.rotatedKeysOf(umk, store.adoptedScheme?.scheme ?? "web").irkPubHex) }; },
    clearAccountReadTokens: () => calls.push("tokens"),
    fetchAccountKeys: async () => ({ irkPub: opts.comIrk ?? account.irkPubHex, adminRootPub: pub(ROOT), keyEpoch: 0 }),
    postRotation: vi.fn(async () => {
      if ((opts.postStatus ?? 200) !== 200) throw Object.assign(new Error("refused"), { status: opts.postStatus });
      return { applied: true, keyEpoch: 1, revokedDeviceIds: [LOST_ID] };
    }),
    signedDirectoryFetch: vi.fn(async (path: string, init: any) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/ack")) {
        store.acked.push(JSON.parse(init.body).toEpoch);
        return new Response("{}", { status: 200 });
      }
      if (path.endsWith("/receive-key")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ keyEpoch: 1, deliveries: opts.deliveries ?? [], lane: opts.lane ?? [] }), { status: 200 });
    }),
    markRotationDone: vi.fn(),
  };
  return { calls, store, session, profile, deps };
}

describe("the receiver end to end", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, String(v)), removeItem: (k: string) => m.delete(k), clear: () => m.clear() };
  });

  it("installs the new key, keeps the old one retired, acknowledges", async () => {
    const { out } = await built();
    const h = harness({ comIrk: out.body.rotation.newIrkPubHex, deliveries: [{ toEpoch: 1, ...out.body.deliveries[0] }], lane: laneFor(out.body) });
    h.store.receive = { seed: PHONE_RECEIVE, publishedFor: pub(PHONE_SEED) };
    C.pinAdminRoot(U, pub(ROOT));
    const res = await C.receiveAccountKey({ session: h.session, profile: h.profile }, h.deps);
    expect(res).toEqual({ state: "updated", toEpoch: 1 });
    expect(h.store.installed).toEqual([{ o: hex(OLD_UMK), n: hex(seed(9)), e: 1 }]);
    expect(hex(h.session.umk)).toBe(hex(seed(9)));
    expect(h.store.adoptedScheme).toEqual({ scheme: "web", version: 1 });
    expect(h.store.acked).toEqual([1]);
    expect(h.store.deviceSeeds.get(`${hex(seed(9))}|${PHONE_ID}`)).toEqual(PHONE_SEED);
    expect(h.store.receive.seed).toEqual(PHONE_RECEIVE);
  });

  it("does nothing while its key is the one .com serves", async () => {
    const h = harness();
    expect(await C.receiveAccountKey({ session: h.session, profile: h.profile }, h.deps)).toEqual({ state: "current" });
    expect(h.deps.signedDirectoryFetch).not.toHaveBeenCalled();
  });

  it("installs nothing when the lane does not start from its key", async () => {
    const { out } = await built();
    const h = harness({ comIrk: out.body.rotation.newIrkPubHex, deliveries: [{ toEpoch: 1, ...out.body.deliveries[0] }], lane: [] });
    C.pinAdminRoot(U, pub(ROOT));
    await expect(C.receiveAccountKey({ session: h.session, profile: h.profile }, h.deps)).rejects.toMatchObject({ code: "wrong-old-irk" });
    expect(h.store.installed).toEqual([]);
  });

  it("hears removed when .com refuses its own request", async () => {
    const h = harness({ comIrk: "e".repeat(64) });
    h.deps.signedDirectoryFetch = async () => new Response(JSON.stringify({ code: "device-removed" }), { status: 403 });
    expect(await C.receiveAccountKey({ session: h.session, profile: h.profile }, h.deps)).toEqual({ state: "removed" });
  });
});

describe("the rotator end to end", () => {
  it("keeps the request pending, posts it, then makes the new key current", async () => {
    const { dir, plan } = await built();
    const h = harness();
    h.profile.deviceId = SELF_ID;
    const res = await C.runRotation({ session: h.session, profile: h.profile, plan, directory: dir, account }, { ...h.deps, withAdminRoot: (k: Uint8Array, fn: any) => fn({ edSeed: k }) });
    expect(res.toEpoch).toBe(1);
    expect(h.deps.postRotation).toHaveBeenCalledTimes(1);
    expect(h.store.installed).toHaveLength(1);
    expect(h.store.pending).toBeNull();
    expect(h.deps.markRotationDone).toHaveBeenCalled();
  });

  it("drops the pending slot and changes nothing on a conflict another admin won", async () => {
    const { dir, plan } = await built();
    const h = harness({ postStatus: 409, comIrk: "e".repeat(64) });
    await expect(C.runRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID }, plan, directory: dir, account }, { ...h.deps, withAdminRoot: (k: Uint8Array, fn: any) => fn({ edSeed: k }) })).rejects.toMatchObject({ status: 409 });
    expect(h.store.pending).toBeNull();
    expect(h.store.installed).toEqual([]);
  });

  it("treats a conflict as success when .com already serves the new key (a retry that raced)", async () => {
    const { dir, plan } = await built();
    const h = harness({ postStatus: 409 });
    let newIrk = "";
    h.deps.putPendingRotation = async (_u: any, p: any) => { h.store.pending = p; newIrk = p.body.rotation.newIrkPubHex; };
    h.deps.fetchAccountKeys = async () => ({ irkPub: newIrk, adminRootPub: pub(ROOT), keyEpoch: 1 });
    const res = await C.runRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID }, plan, directory: dir, account }, { ...h.deps, withAdminRoot: (k: Uint8Array, fn: any) => fn({ edSeed: k }) });
    expect(res.toEpoch).toBe(1);
    expect(h.store.installed).toHaveLength(1);
  });
});

describe("resuming a pending change", () => {
  const pendingWith = (issuedAt: number) => ({ newUmk: seed(9), toEpoch: 1, issuedAt, body: { rotation: { newIrkScheme: "web" }, kept: [] } });

  it("promotes when .com already serves the pending key", async () => {
    const h = harness({ comIrk: C.rotatedKeysOf(seed(9)).irkPubHex, pending: pendingWith(Date.now()) });
    expect(await C.resumePendingRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID } }, h.deps)).toBe("promoted");
    expect(h.store.installed).toHaveLength(1);
  });

  it("sends the same body once more while it is fresh and .com is still on this key", async () => {
    const h = harness({ pending: pendingWith(Date.now()) });
    expect(await C.resumePendingRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID } }, h.deps)).toBe("resent");
    expect(h.deps.postRotation).toHaveBeenCalledTimes(1);
  });

  it("drops a stale one", async () => {
    const h = harness({ pending: pendingWith(Date.now() - 3_600_000) });
    expect(await C.resumePendingRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID } }, h.deps)).toBe("dropped");
    expect(h.store.pending).toBeNull();
    expect(h.store.installed).toEqual([]);
  });

  it("drops one when .com moved to a key it does not hold", async () => {
    const h = harness({ comIrk: "e".repeat(64), pending: pendingWith(Date.now()) });
    expect(await C.resumePendingRotation({ session: h.session, profile: { accountId: U, deviceId: SELF_ID } }, h.deps)).toBe("dropped");
  });
});

describe("the receive key and the device-key move", () => {
  it("publishes a receive key signed by the device key, once per device key", async () => {
    const h = harness();
    const bodies: any[] = [];
    h.deps.signedDirectoryFetch = async (_p: string, init: any) => { bodies.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
    expect(await C.ensureReceiveKey({ session: h.session, profile: h.profile }, h.deps)).toBe("published");
    const b = bodies[0];
    expect(b.receiveKey.devicePubHex).toBe(pub(PHONE_SEED));
    expect(P.verifyDeviceReceiveKey(b.receiveKey, b.signatureHex)).toBe(true);
    expect(await C.ensureReceiveKey({ session: h.session, profile: h.profile }, h.deps)).toBe("current");
    expect(bodies).toHaveLength(1);
  });

  it("moves an admin browser off a derived key with the admin root's signature and a grant", async () => {
    const derived = derivedPub(OLD_UMK, SELF_ID);
    const derivedSeed = derivedSeedOf(OLD_UMK, SELF_ID);
    expect(pub(derivedSeed)).toBe(derived);
    let sent: any = null;
    const persisted: Uint8Array[] = [];
    const res = await C.migrateDerivedDeviceKey(
      { session: { umk: OLD_UMK, adminRootSeed: ROOT }, profile: { accountId: U, deviceId: SELF_ID }, grant: { scopesJson: JSON.stringify(["browse", "admin"]) } },
      {
        deriveAccountDeviceSeed: async () => derivedSeed,
        persistAccountDeviceSeed: async (_u: any, _a: any, _i: any, s: Uint8Array) => { persisted.push(s); },
        withAdminRoot: (k: Uint8Array, fn: any) => fn({ edSeed: k }),
        fetch: async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response("{}", { status: 200 }); },
        baseUrl: "https://com.test",
      },
    );
    expect(res).toBe("migrated");
    expect(sent.rotate.oldDevicePubHex).toBe(derived);
    expect(P.verifyDeviceKeyRotate(sent.rotate, sent, pub(ROOT))).toBe(true);
    expect(sent.grant.signerRoot).toBe("admin-root");
    expect(sent.grant.grant.devicePubKey).toBe(sent.rotate.newDevicePubHex);
    expect(pub(persisted[0]!)).toBe(sent.rotate.newDevicePubHex);
  });

  it("leaves a random key alone, and a non-admin derived one too", async () => {
    const base = { deriveAccountDeviceSeed: async () => SELF_SEED, persistAccountDeviceSeed: async () => {} };
    expect(await C.migrateDerivedDeviceKey({ session: { umk: OLD_UMK, adminRootSeed: ROOT }, profile: { accountId: U, deviceId: SELF_ID }, grant: null }, base)).toBe("random");
    const derivedSeed = derivedSeedOf(OLD_UMK, SELF_ID);
    expect(await C.migrateDerivedDeviceKey({ session: { umk: OLD_UMK, adminRootSeed: null }, profile: { accountId: U, deviceId: SELF_ID }, grant: null }, { ...base, deriveAccountDeviceSeed: async () => derivedSeed })).toBe("not-admin");
  });
});

describe("progress", () => {
  it("counts kept devices back in the directory and servers on the new epoch", () => {
    const p = C.rotationProgress({
      keyEpoch: 1,
      kept: [{ deviceId: SELF_ID }, { deviceId: PHONE_ID }],
      selfProfiles: [{ deviceId: SELF_ID }],
      serverStatuses: [{ name: "home", status: { trustedEpoch: 1, rekeyDue: ["luks"] } }, { name: "cabin", status: { trustedEpoch: 0 } }, { name: "attic", status: null }],
    });
    expect(p.devices).toEqual({ updated: 1, total: 2 });
    expect(p.servers).toEqual({ updated: 1, total: 3, waiting: ["cabin", "attic"], rekeyDue: [{ name: "home", what: "luks" }] });
    expect(C.rotationComplete(p)).toBe(false);
  });

  it("offers the change only when every server reports the capability", () => {
    expect(C.serverNotReady([{ name: "a", status: { capability: C.ACCOUNT_KEY_CAPABILITY } }])).toBeNull();
    expect(C.serverNotReady([{ name: "a", status: { capability: C.ACCOUNT_KEY_CAPABILITY } }, { name: "b", status: null }])?.name).toBe("b");
  });
});

afterEach(() => vi.restoreAllMocks());
