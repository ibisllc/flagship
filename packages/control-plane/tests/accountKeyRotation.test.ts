/**
 * `.com` side of the account master-key rotation (accountKeyRotation.ts), run against the in-memory
 * adapter and the real D1 adapter over SQLite.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  accountKeyRotationDigestHex,
  buildUmkRotationDelivery,
  deriveAidSeed,
  deriveIrkSeedInScheme,
  ed,
  encodeUmkRotationPlaintext,
  keptDevicesDigestHex,
  recoveryRecordDigest,
  sealUmkRotation,
  signAccountDirectoryRequest,
  signAccountKeyRotation,
  signAdminRootRotation,
  signDeviceCapabilityGrant,
  signDeviceKeyRotate,
  signDeviceReceiveKey,
  signAccountKeyRotationPq,
  hybridSign,
  hybridSigKeygen,
  canonicalPqKeyBinding,
  type PqKeyBindingStatement,
  type PqKeyBindingWire,
  hybridSealKeygen,
  HYBRID_SEAL_SECRET_KEY_LEN,
  signRecoveryRecord,
  type AccountKeyRotation,
  type DeviceCapabilityGrant,
  type RecoveryRecordV2,
} from "@flagship/protocol";
import { D1Storage, InMemoryStorage, type Storage } from "@flagship/storage";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import {
  handleAckUmkRotationDeliveries,
  handleApplyAccountKeyRotation,
  handleGetUmkRotationDeliveries,
  handleListAccountKeyRotations,
  handlePutDeviceReceiveKey,
  handleRotateDeviceKey,
  type AccountKeyRotationDeps,
} from "../src/accountKeyRotation.js";
import { handleUsernameLookup } from "../src/usernameClaim.js";

const NOW = 1_800_000_000_000;
const U = "alice";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const kp = (seed = rnd(32)) => ({ privateKey: seed, publicKey: ed.getPublicKey(seed) });
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function nonces() {
  const seen = new Set<string>();
  return { claim: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)) };
}

interface Device { id: string; key: ReturnType<typeof kp> }

async function fixture(adapter: "InMemory" | "D1") {
  const db = adapter === "D1" ? createSqliteD1() : null;
  const s: Storage = db ? new D1Storage(db) : new InMemoryStorage();
  const umk = rnd(32);
  const irk = kp(deriveIrkSeedInScheme(umk, "web", 1));
  const aid = kp(deriveAidSeed(umk));
  const root = kp();
  await s.usernames.put({ username: U, irkPubHex: hex(irk.publicKey), aidPubHex: hex(aid.publicKey), adminRootPubHex: hex(root.publicKey), claimedAt: NOW - 1000 });
  const devices: Device[] = [];
  for (let i = 0; i < 3; i++) {
    const d = { id: hex(rnd(16)), key: kp() };
    devices.push(d);
    await s.deviceIdentities.put({ accountId: U, deviceId: d.id, devicePubHex: hex(d.key.publicKey), platformClass: "web", createdAt: NOW - 500 + i, lastSeenAt: NOW, revokedAt: null });
  }
  // devices[0] = the rotating admin (admin-root grant), [1] kept (membership grant), [2] removed.
  const grant = async (d: Device, signer: ReturnType<typeof kp>, root: "admin-root" | "membership", scopes: string[]) => {
    const g: DeviceCapabilityGrant = { grantId: hex(rnd(16)), username: U, deviceId: d.id, devicePubKey: d.key.publicKey, scopes: scopes as DeviceCapabilityGrant["scopes"], issuedAt: NOW - 400, expiresAt: NOW + 86_400_000 };
    await s.deviceCapabilityGrants.put({ grantId: g.grantId, username: U, deviceId: d.id, devicePubHex: hex(d.key.publicKey), scopesJson: JSON.stringify(scopes), issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: hex(signDeviceCapabilityGrant(g, signer)), revokedAt: null, signerRoot: root });
  };
  await grant(devices[0]!, root, "admin-root", ["admin", "view-directory"]);
  await grant(devices[1]!, irk, "membership", ["view-directory"]);
  await grant(devices[2]!, irk, "membership", ["view-directory"]);
  for (const d of devices) {
    await s.pushTokens.put({ tokenId: hex(rnd(16)), username: U, deviceId: d.id, platform: "webpush", providerToken: `tok-${d.id}`, pushX25519PubHex: hex(rnd(32)), registrationSignatureHex: "00".repeat(64), registeredAt: NOW, lastSeenAt: NOW });
  }
  const deps: AccountKeyRotationDeps = {
    usernames: s.usernames, rotations: s.accountKeyRotations, adminRootRotations: s.adminRootRotations, identities: s.deviceIdentities,
    grants: s.deviceCapabilityGrants, pushTokens: s.pushTokens, webauthnRecovery: s.webauthnRecovery, accountProfiles: s.accountProfiles,
    managedProfiles: s.deviceManagedProfiles, nonces: nonces(), now: () => NOW,
  };
  return { s, deps, umk, irk, aid, root, devices, done: () => db?.close() };
}

type Fx = Awaited<ReturnType<typeof fixture>>;

/** A full rotation body: keeps devices[0] and [1], removes [2]. */
function rotationBody(fx: Fx, opts: { nonce?: string; recovery?: { claim: RecoveryRecordV2; signature: string; wrappedUmk: string } | null; signer?: ReturnType<typeof kp>; keep?: Device[]; fromEpoch?: number; oldIrk?: string } = {}) {
  const newUmk = rnd(32);
  const newIrk = kp(deriveIrkSeedInScheme(newUmk, "web", 1));
  const newAid = kp(deriveAidSeed(newUmk));
  const keep = opts.keep ?? [fx.devices[0]!, fx.devices[1]!];
  const kept = keep.map((d) => ({ deviceId: d.id, devicePubHex: hex(d.key.publicKey) }));
  const fromEpoch = opts.fromEpoch ?? 0;
  const rotation: AccountKeyRotation = {
    username: U, fromEpoch, toEpoch: fromEpoch + 1, oldIrkPubHex: opts.oldIrk ?? hex(fx.irk.publicKey), newIrkPubHex: hex(newIrk.publicKey), newIrkScheme: "web",
    oldAidPubHex: hex(fx.aid.publicKey), newAidPubHex: hex(newAid.publicKey), adminRootPubHex: hex(fx.root.publicKey),
    removedDeviceIds: fx.devices.filter((d) => !keep.includes(d)).map((d) => d.id), keptDevicesDigestHex: keptDevicesDigestHex(kept),
    recoveryRecordDigestHex: opts.recovery ? recoveryRecordDigest(opts.recovery.claim) : null, nonceHex: opts.nonce ?? hex(rnd(16)), issuedAt: NOW,
  };
  const signatures = signAccountKeyRotation(rotation, { adminRoot: opts.signer ?? fx.root, newIrk, newAid });
  const plain = encodeUmkRotationPlaintext({ umk: newUmk, irkScheme: "web" });
  const deliveries = keep.slice(1).map((d) => {
    const { sealed } = sealUmkRotation({ rotation, deviceId: d.id, plaintext: plain, recipient: { kind: "ed25519", devicePub: d.key.publicKey }, issuedAt: NOW });
    const { delivery, signatureHex } = buildUmkRotationDelivery({ rotation, deviceId: d.id, devicePubHex: hex(d.key.publicKey), sealed, issuedAt: NOW, adminRoot: fx.root });
    return { delivery, signatureHex, sealKind: "ed25519", sealedHex: hex(sealed) };
  });
  // devices[1]'s membership grant is replaced by one signed by the new IRK (member scopes).
  const grants = keep.includes(fx.devices[1]!) ? [(() => {
    const d = fx.devices[1]!;
    const g: DeviceCapabilityGrant = { grantId: hex(rnd(16)), username: U, deviceId: d.id, devicePubKey: d.key.publicKey, scopes: ["view-directory"], issuedAt: NOW, expiresAt: NOW + 86_400_000 };
    return { grant: { ...g, devicePubKey: hex(d.key.publicKey) }, signature: hex(signDeviceCapabilityGrant(g, newIrk)), signerRoot: "membership" };
  })()] : [];
  return {
    body: { rotation, signatures, kept, deliveries, grants, ...(opts.recovery ? { recovery: opts.recovery } : {}) },
    newIrk, newAid, newUmk, rotation,
  };
}

function directoryAuth(d: Device, method: string, path: string) {
  const request = { accountId: U, deviceId: d.id, signerPubHex: hex(d.key.publicKey), method, path, requestId: hex(rnd(16)), issuedAt: NOW };
  return { request, signature: signAccountDirectoryRequest(request, d.key) };
}

for (const adapter of ["InMemory", "D1"] as const) {
  describe(`${adapter}: account key rotation on .com`, () => {
    it("swaps the keys, revokes the device not kept, stores the delivery, answers a replay with applied:false", async () => {
      const fx = await fixture(adapter);
      try {
        const { body, newIrk } = rotationBody(fx);
        const res = await handleApplyAccountKeyRotation(fx.deps, U, body);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ applied: true, keyEpoch: 1, revokedDeviceIds: [fx.devices[2]!.id] });
        const user = await fx.s.usernames.get(U);
        expect(user?.irkPubHex).toBe(hex(newIrk.publicKey));
        expect(user?.keyEpoch).toBe(1);
        expect((await fx.s.deviceIdentities.get(U, fx.devices[2]!.id))?.revokedAt).toBe(NOW);
        expect((await fx.s.deviceIdentities.get(U, fx.devices[1]!.id))?.revokedAt).toBeNull();
        const active = (await fx.s.deviceCapabilityGrants.listForUser(U)).filter((g) => g.revokedAt === null);
        expect(active.map((g) => g.deviceId).sort()).toEqual([fx.devices[0]!.id, fx.devices[1]!.id].sort());
        expect((await fx.s.pushTokens.listByUser(U)).some((t) => t.deviceId === fx.devices[2]!.id)).toBe(false);
        expect((await fx.s.auditEvents.list(U, 0, 10)).some((e) => e.eventKind === "account-key-rotated")).toBe(true);
        expect(((await handleUsernameLookup(fx.s.usernames, U)).body as { keyEpoch: number }).keyEpoch).toBe(1);

        const again = await handleApplyAccountKeyRotation(fx.deps, U, body);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ applied: false, keyEpoch: 1 });

        const lane = await handleListAccountKeyRotations(fx.deps, U);
        const events = (lane.body as { lane: Array<{ kind: string }> }).lane;
        expect(events.map((e) => e.kind)).toEqual(["account-key-rotation"]);

        // The kept device fetches its delivery, then acknowledges it.
        const d1 = fx.devices[1]!;
        const path = `/api/accounts/${U}/devices/${d1.id}/umk-rotation`;
        const got = await handleGetUmkRotationDeliveries(fx.deps, U, d1.id, directoryAuth(d1, "GET", path));
        expect(got.status).toBe(200);
        expect((got.body as { deliveries: unknown[] }).deliveries).toHaveLength(1);
        const ack = await handleAckUmkRotationDeliveries(fx.deps, U, d1.id, directoryAuth(d1, "POST", `${path}/ack`), { toEpoch: 1 });
        expect(ack.body).toMatchObject({ acked: 1 });
        // The removed device hears that it was removed.
        const d2 = fx.devices[2]!;
        const gone = await handleGetUmkRotationDeliveries(fx.deps, U, d2.id, directoryAuth(d2, "GET", `/api/accounts/${U}/devices/${d2.id}/umk-rotation`));
        expect(gone.status).toBe(403);
      } finally {
        fx.done();
      }
    });

    it("lets only one of two racing rotations from the same epoch win", async () => {
      const fx = await fixture(adapter);
      try {
        const a = rotationBody(fx);
        const b = rotationBody(fx);
        const [ra, rb] = await Promise.all([handleApplyAccountKeyRotation(fx.deps, U, a.body), handleApplyAccountKeyRotation(fx.deps, U, b.body)]);
        expect([ra.status, rb.status].sort()).toEqual([200, 409]);
        const user = await fx.s.usernames.get(U);
        const winner = ra.status === 200 ? a : b;
        expect(user?.irkPubHex).toBe(hex(winner.newIrk.publicKey));
        expect(await fx.s.accountKeyRotations.list(U)).toHaveLength(1);
      } finally {
        fx.done();
      }
    });

    it("refuses a hop signed by anything but the pinned admin root (the old IRK, a grant-holding admin device)", async () => {
      const fx = await fixture(adapter);
      try {
        for (const signer of [fx.irk, fx.devices[0]!.key, kp()]) {
          const { body } = rotationBody(fx, { signer });
          const res = await handleApplyAccountKeyRotation(fx.deps, U, body);
          expect(res.status).toBe(403);
          expect((res.body as { code: string }).code).toBe("bad-admin-signature");
        }
        // A hop that names the old IRK as its authority is refused before any signature.
        const { body } = rotationBody(fx);
        const forged = { ...body, rotation: { ...body.rotation, adminRootPubHex: hex(fx.irk.publicKey) } };
        expect((await handleApplyAccountKeyRotation(fx.deps, U, forged)).status).toBe(403);
        expect((await fx.s.usernames.get(U))?.irkPubHex).toBe(hex(fx.irk.publicKey));
        expect(await fx.s.accountKeyRotations.list(U)).toHaveLength(0);
      } finally {
        fx.done();
      }
    });

    it("refuses a stale epoch and a wrong old key (409) and applies nothing", async () => {
      const fx = await fixture(adapter);
      try {
        expect((await handleApplyAccountKeyRotation(fx.deps, U, rotationBody(fx, { fromEpoch: 1 }).body)).status).toBe(409);
        expect((await handleApplyAccountKeyRotation(fx.deps, U, rotationBody(fx, { oldIrk: hex(kp().publicKey) }).body)).status).toBe(409);
        expect((await fx.s.deviceIdentities.get(U, fx.devices[2]!.id))?.revokedAt).toBeNull();
      } finally {
        fx.done();
      }
    });

    it("supersedes a pending re-pair in the same step", async () => {
      const fx = await fixture(adapter);
      try {
        await fx.s.pendingRePairs.initiate({ username: U, newIrkPubHex: hex(kp().publicKey), oldIrkPubHex: hex(fx.irk.publicKey), initiatedAt: NOW - 100, completesAt: NOW + 86_400_000 });
        expect((await handleApplyAccountKeyRotation(fx.deps, U, rotationBody(fx).body)).status).toBe(200);
        expect((await fx.s.pendingRePairs.get(U))?.objectedAt).toBe(NOW);
        expect(await fx.s.pendingRePairs.claimCompletion(U, NOW + 1)).toBe(false);
      } finally {
        fx.done();
      }
    });

    it("swaps the recovery record atomically, and applies nothing when it changed meanwhile", async () => {
      const fx = await fixture(adapter);
      try {
        const oldUmkWrap = rnd(48);
        const old: RecoveryRecordV2 = {
          op: "put", username: U, irkPubHex: hex(fx.irk.publicKey), adminRootPubHex: hex(fx.root.publicKey), credentialIdHex: hex(rnd(16)),
          wrappedUmkDigestHex: hex(sha256(oldUmkWrap)), adminRoot: { change: "none" }, acmeKey: { change: "none" }, fetchTokenHashHex: hex(rnd(32)),
          prfSaltHashHex: hex(rnd(32)), kdfVersion: 1, algVersion: 1, policy: "passkey-and-passphrase", generation: 1, nonceHex: hex(rnd(16)), priorDigestHex: "genesis", issuedAt: NOW,
        };
        await fx.s.webauthnRecovery.upsert({
          username: U, credentialIdHex: old.credentialIdHex, wrappedUmkB64: b64(oldUmkWrap), irkPubHex: old.irkPubHex,
          signed: { digestHex: recoveryRecordDigest(old), generation: 1, signedClaimJson: JSON.stringify(old), signatureHex: "00".repeat(64) }, createdAt: NOW, updatedAt: NOW,
        });
        const newWrap = rnd(48);
        // The new record is signed by the new IRK, which is minted inside rotationBody: build it in two steps.
        const draft = rotationBody(fx);
        const claim: RecoveryRecordV2 = {
          ...old, irkPubHex: hex(draft.newIrk.publicKey), wrappedUmkDigestHex: hex(sha256(newWrap)), generation: 2, priorDigestHex: recoveryRecordDigest(old), nonceHex: hex(rnd(16)),
        };
        const recovery = { claim, signature: hex(signRecoveryRecord(claim, draft.newIrk)), wrappedUmk: b64(newWrap) };
        const rotation = { ...draft.rotation, recoveryRecordDigestHex: recoveryRecordDigest(claim) };
        const signatures = signAccountKeyRotation(rotation, { adminRoot: fx.root, newIrk: draft.newIrk, newAid: draft.newAid });
        // Deliveries name the hop's digest, so they are rebuilt for the changed hop.
        const deliveries = draft.body.deliveries.map((d) => {
          const sealed = fromHex(d.sealedHex);
          const r = buildUmkRotationDelivery({ rotation, deviceId: d.delivery.deviceId, devicePubHex: d.delivery.devicePubHex, sealed, issuedAt: NOW, adminRoot: fx.root });
          return { ...d, delivery: r.delivery, signatureHex: r.signatureHex };
        });
        const body = { ...draft.body, rotation, signatures, deliveries, recovery };

        // Another write lands first: the hop's precondition no longer holds.
        const other = { ...old, generation: 2, priorDigestHex: recoveryRecordDigest(old), nonceHex: hex(rnd(16)) };
        await fx.s.webauthnRecovery.replaceIfDigest({ username: U, credentialIdHex: old.credentialIdHex, wrappedUmkB64: b64(oldUmkWrap), irkPubHex: old.irkPubHex, signed: { digestHex: recoveryRecordDigest(other), generation: 2, signedClaimJson: "{}", signatureHex: "00".repeat(64) }, createdAt: NOW, updatedAt: NOW }, recoveryRecordDigest(old));
        const refused = await handleApplyAccountKeyRotation(fx.deps, U, body);
        expect(refused.status).toBe(409);
        expect((await fx.s.usernames.get(U))?.irkPubHex).toBe(hex(fx.irk.publicKey));
        expect((await fx.s.deviceIdentities.get(U, fx.devices[2]!.id))?.revokedAt).toBeNull();

        // Put the original back: now the swap goes through, record and keys together.
        await fx.s.webauthnRecovery.upsert({ username: U, credentialIdHex: old.credentialIdHex, wrappedUmkB64: b64(oldUmkWrap), irkPubHex: old.irkPubHex, signed: { digestHex: recoveryRecordDigest(old), generation: 1, signedClaimJson: JSON.stringify(old), signatureHex: "00".repeat(64) }, createdAt: NOW, updatedAt: NOW });
        const res = await handleApplyAccountKeyRotation(fx.deps, U, body);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const rec = await fx.s.webauthnRecovery.get(U);
        expect(rec?.irkPubHex).toBe(hex(draft.newIrk.publicKey));
        expect(rec?.signed?.digestHex).toBe(recoveryRecordDigest(claim));
      } finally {
        fx.done();
      }
    });

    it("deletes the recovery record when the hop names none", async () => {
      const fx = await fixture(adapter);
      try {
        await fx.s.webauthnRecovery.upsert({ username: U, credentialIdHex: "ab".repeat(16), wrappedUmkB64: b64(rnd(16)), irkPubHex: hex(fx.irk.publicKey), createdAt: NOW, updatedAt: NOW });
        expect((await handleApplyAccountKeyRotation(fx.deps, U, rotationBody(fx).body)).status).toBe(200);
        expect(await fx.s.webauthnRecovery.get(U)).toBeUndefined();
      } finally {
        fx.done();
      }
    });

    it("needs a fresh grant for a kept device whose grant the old account key signed", async () => {
      const fx = await fixture(adapter);
      try {
        const { body } = rotationBody(fx);
        const res = await handleApplyAccountKeyRotation(fx.deps, U, { ...body, grants: [] });
        expect((res.body as { code: string }).code).toBe("kept-device-needs-grant");
        expect((await fx.s.usernames.get(U))?.keyEpoch ?? 0).toBe(0);
      } finally {
        fx.done();
      }
    });

    it("under strict, refuses a classical delivery and a hop without its hybrid companion", async () => {
      const fx = await fixture(adapter);
      try {
        await fx.s.servers.put({ serverDomain: "home.alice.flagship.services", username: U, identityPubKeyHex: hex(kp().publicKey), registeredAt: NOW });
        const strictDeps: AccountKeyRotationDeps = {
          ...fx.deps,
          servers: fx.s.servers,
          pqTrust: { ...fx.s.pqTrust, getPolicy: async (kind: string, id: string) => (kind === "installation" ? { scopeKind: kind, scopeId: id, profile: "strict", rollout: "enforced", generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: NOW } : null) } as never,
        };
        const res = await handleApplyAccountKeyRotation(strictDeps, U, rotationBody(fx).body);
        expect(res.status).toBe(403);
        expect(["strict-requires-hybrid", "strict-requires-xwing-delivery"]).toContain((res.body as { code: string }).code);
        expect((await fx.s.usernames.get(U))?.keyEpoch ?? 0).toBe(0);
      } finally {
        fx.done();
      }
    });

    it("under strict, takes a hybrid hop with X-Wing deliveries, refuses the classical seal and a bad companion", async () => {
      const fx = await fixture(adapter);
      try {
        const bind = (edSeed: Uint8Array, mlSeed: Uint8Array, role: PqKeyBindingStatement["role"]): PqKeyBindingWire => {
          const { publicKey } = hybridSigKeygen(edSeed, mlSeed);
          const st: PqKeyBindingStatement = { role, subjectId: U, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: NOW - 10 };
          return { v: 1, ...st, signature: hex(hybridSign(new Uint8Array([...edSeed, ...mlSeed]), "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st))) };
        };
        const rootMl = rnd(32);
        const rootBinding = bind(fx.root.privateKey, rootMl, "admin-root");
        await fx.s.pqTrust.putBinding({ role: "admin-root", subjectId: U, ed25519PubHex: rootBinding.ed25519PubHex, mldsaPubHex: rootBinding.mldsaPubHex, issuedAt: rootBinding.issuedAt, signatureHex: rootBinding.signature, storedAt: NOW });
        await fx.s.servers.put({ serverDomain: "home.alice.flagship.services", username: U, identityPubKeyHex: hex(kp().publicKey), registeredAt: NOW });
        const strictDeps: AccountKeyRotationDeps = {
          ...fx.deps,
          servers: fx.s.servers,
          pqTrust: new Proxy(fx.s.pqTrust, {
            get: (t, k) => (k === "getPolicy"
              ? async (kind: string, id: string) => (kind === "installation" ? { scopeKind: kind, scopeId: id, profile: "strict", rollout: "enforced", generation: 1, headDigest: "00".repeat(32), enforcedEver: true, updatedAt: NOW } : null)
              : (t as unknown as Record<string | symbol, unknown>)[k as string]),
          }) as AccountKeyRotationDeps["pqTrust"],
        };
        const withPq = (b: ReturnType<typeof rotationBody>) => {
          const irkBinding = bind(b.newIrk.privateKey, rnd(32), "account-irk");
          return signAccountKeyRotationPq(b.rotation, new Uint8Array([...fx.root.privateKey, ...rootMl]), irkBinding);
        };
        const classical = rotationBody(fx);
        const refused = await handleApplyAccountKeyRotation(strictDeps, U, { ...classical.body, pq: withPq(classical) });
        expect((refused.body as { code: string }).code).toBe("strict-requires-xwing-delivery");

        // The kept device's X-Wing receive key; its delivery is sealed to it.
        const d1 = fx.devices[1]!;
        const recv = hybridSealKeygen(rnd(HYBRID_SEAL_SECRET_KEY_LEN));
        const rk = { username: U, deviceId: d1.id, devicePubHex: hex(d1.key.publicKey), xwingPubHex: hex(recv.publicKey), issuedAt: NOW };
        await handlePutDeviceReceiveKey(fx.deps, U, d1.id, directoryAuth(d1, "PUT", `/api/accounts/${U}/devices/${d1.id}/receive-key`), { receiveKey: rk, signatureHex: signDeviceReceiveKey(rk, d1.key) });
        const b = rotationBody(fx);
        const { sealed } = sealUmkRotation({ rotation: b.rotation, deviceId: d1.id, plaintext: encodeUmkRotationPlaintext({ umk: b.newUmk, irkScheme: "web" }), recipient: { kind: "xwing", publicKey: recv.publicKey }, issuedAt: NOW });
        const dv = buildUmkRotationDelivery({ rotation: b.rotation, deviceId: d1.id, devicePubHex: hex(d1.key.publicKey), sealed, issuedAt: NOW, adminRoot: fx.root });
        const xwingBody = { ...b.body, deliveries: [{ delivery: dv.delivery, signatureHex: dv.signatureHex, sealKind: "xwing", sealedHex: hex(sealed) }] };

        // Outside strict too: a companion that is sent must verify.
        const badPq = { ...withPq(b), signature: { suite: "hybrid-ed25519-mldsa65/v1", signature: "00".repeat(3373) } };
        expect((await handleApplyAccountKeyRotation({ ...fx.deps, pqTrust: fx.s.pqTrust }, U, { ...xwingBody, pq: badPq })).status).toBe(403);
        expect((await handleApplyAccountKeyRotation(strictDeps, U, xwingBody)).status).toBe(403);
        const res = await handleApplyAccountKeyRotation(strictDeps, U, { ...xwingBody, pq: withPq(b) });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect((await fx.s.pqTrust.getBinding("account-irk", U))?.ed25519PubHex).toBe(hex(b.newIrk.publicKey));
      } finally {
        fx.done();
      }
    });

    it("chains an embedded admin-root rotation first, and the lane orders the hop after it", async () => {
      const fx = await fixture(adapter);
      try {
        const newRoot = kp();
        const rot = { username: U, oldAdminRootPub: fx.root.publicKey, newAdminRootPub: newRoot.publicKey, issuedAt: NOW };
        const adminRootRotation = { rotation: { username: U, oldAdminRootPub: hex(fx.root.publicKey), newAdminRootPub: hex(newRoot.publicKey), issuedAt: NOW }, signatureHex: hex(signAdminRootRotation(rot, fx.root)) };
        const moved = { ...fx, root: newRoot };
        const { body } = rotationBody(moved);
        const res = await handleApplyAccountKeyRotation(fx.deps, U, { ...body, adminRootRotation });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const lane = (await handleListAccountKeyRotations(fx.deps, U)).body as { lane: Array<{ kind: string }> };
        expect(lane.lane.map((e) => e.kind)).toEqual(["admin-root-rotation", "account-key-rotation"]);
      } finally {
        fx.done();
      }
    });

    it("stores a device's receive key and rotates a device key under the admin root", async () => {
      const fx = await fixture(adapter);
      try {
        const d = fx.devices[1]!;
        {
          const rk = { username: U, deviceId: d.id, devicePubHex: hex(d.key.publicKey), xwingPubHex: hex(hybridSealKeygen(rnd(HYBRID_SEAL_SECRET_KEY_LEN)).publicKey), issuedAt: NOW };
          const path = `/api/accounts/${U}/devices/${d.id}/receive-key`;
          const put = await handlePutDeviceReceiveKey(fx.deps, U, d.id, directoryAuth(d, "PUT", path), { receiveKey: rk, signatureHex: signDeviceReceiveKey(rk, d.key) });
          expect(put.status, JSON.stringify(put.body)).toBe(200);
          expect((await fx.s.accountKeyRotations.listReceiveKeys(U))).toHaveLength(1);
        }

        const next = kp();
        const r = { username: U, deviceId: d.id, oldDevicePubHex: hex(d.key.publicKey), newDevicePubHex: hex(next.publicKey), issuedAt: NOW };
        const sigs = signDeviceKeyRotate(r, { newKey: next, adminRoot: fx.root });
        const g: DeviceCapabilityGrant = { grantId: hex(rnd(16)), username: U, deviceId: d.id, devicePubKey: next.publicKey, scopes: ["view-directory"], issuedAt: NOW, expiresAt: NOW + 86_400_000 };
        const grant = { grant: { ...g, devicePubKey: hex(next.publicKey) }, signature: hex(signDeviceCapabilityGrant(g, fx.irk)), signerRoot: "membership" };
        expect((await handleRotateDeviceKey(fx.deps, U, d.id, { rotate: r, ...sigs })).status).toBe(400);
        const wrongRoot = signDeviceKeyRotate(r, { newKey: next, adminRoot: fx.irk });
        expect((await handleRotateDeviceKey(fx.deps, U, d.id, { rotate: r, ...wrongRoot, grant })).status).toBe(403);
        const res = await handleRotateDeviceKey(fx.deps, U, d.id, { rotate: r, ...sigs, grant });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const id = await fx.s.deviceIdentities.get(U, d.id);
        expect(id?.devicePubHex).toBe(hex(next.publicKey));
        expect(id?.keyOrigin).toBe("random");
        expect(await fx.s.accountKeyRotations.listReceiveKeys(U)).toHaveLength(0);
        const live = (await fx.s.deviceCapabilityGrants.listForUser(U)).filter((x) => x.revokedAt === null && x.deviceId === d.id);
        expect(live.map((x) => x.devicePubHex)).toEqual([hex(next.publicKey)]);
        // The same order again is a replay.
        expect((await handleRotateDeviceKey(fx.deps, U, d.id, { rotate: r, ...sigs, grant })).status).toBe(409);
      } finally {
        fx.done();
      }
    });

    it("the hop's digest is its idempotency key", async () => {
      const fx = await fixture(adapter);
      try {
        const { body, rotation } = rotationBody(fx);
        await handleApplyAccountKeyRotation(fx.deps, U, body);
        expect((await fx.s.accountKeyRotations.getByDigest(accountKeyRotationDigestHex(rotation)))?.toEpoch).toBe(1);
      } finally {
        fx.done();
      }
    });
  });
}
