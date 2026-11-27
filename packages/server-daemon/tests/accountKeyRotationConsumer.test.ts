/**
 * The box follows an account master-key rotation (accountKeyRotationConsumer.ts): it replays the lane under
 * the admin root it pins, adopts a verified hop without a re-pair, fails closed on a lost pin and on a
 * higher epoch `.com` reports, and an admin-pinned box no longer takes the old-IRK re-pair proof.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAidSeed,
  deriveIrkSeedInScheme,
  ed,
  keptDevicesDigestHex,
  signAccountKeyRotation,
  signAdminRootRotation,
  signRePairInitiate,
  type AccountKeyRotation,
  type Keypair,
} from "@flagship/protocol";
import {
  AccountKeyEpochGate,
  fileAccountKeyPinStore,
  placeOnLane,
  parseLane,
  pollAccountKeyRotations,
  resolvePinnedAccountKeys,
  type AccountKeyRotationHooks,
} from "../src/accountKeyRotationConsumer.js";
import { verifyRePairSwap } from "../src/postRecovery/rePairWatcher.js";
import { buildOrdersHandler } from "../src/orders.js";
import { Doorbell } from "../src/doorbell.js";

const U = "alice";
const NOW = 1_800_000_000_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (seed = crypto.getRandomValues(new Uint8Array(32))): Keypair => ({ privateKey: seed, publicKey: ed.getPublicKey(seed) });
const DEVICE = "ab".repeat(16);
const REMOVED = "cd".repeat(16);

interface Account { irk: Keypair; aid: Keypair }
function account(): Account {
  const umk = crypto.getRandomValues(new Uint8Array(32));
  return { irk: kp(deriveIrkSeedInScheme(umk, "web", 1)), aid: kp(deriveAidSeed(umk)) };
}

function hop(from: Account, to: Account, root: Keypair, fromEpoch: number, signer: Keypair = root) {
  const rotation: AccountKeyRotation = {
    username: U, fromEpoch, toEpoch: fromEpoch + 1, oldIrkPubHex: hex(from.irk.publicKey), newIrkPubHex: hex(to.irk.publicKey), newIrkScheme: "web",
    oldAidPubHex: hex(from.aid.publicKey), newAidPubHex: hex(to.aid.publicKey), adminRootPubHex: hex(signer === root ? root.publicKey : signer.publicKey),
    removedDeviceIds: [REMOVED], keptDevicesDigestHex: keptDevicesDigestHex([{ deviceId: DEVICE, devicePubHex: "ee".repeat(32) }]),
    recoveryRecordDigestHex: null, nonceHex: hex(crypto.getRandomValues(new Uint8Array(16))), issuedAt: NOW,
  };
  const signatures = signAccountKeyRotation(rotation, { adminRoot: signer, newIrk: to.irk, newAid: to.aid });
  return { kind: "account-key-rotation", rotation, signatures, kept: [] };
}

function rootHop(oldRoot: Keypair, newRoot: Keypair) {
  const r = { username: U, oldAdminRootPub: oldRoot.publicKey, newAdminRootPub: newRoot.publicKey, issuedAt: NOW };
  return {
    kind: "admin-root-rotation",
    seq: 1,
    rotation: { username: U, oldAdminRootPubHex: hex(oldRoot.publicKey), newAdminRootPubHex: hex(newRoot.publicKey), issuedAt: NOW },
    signatureHex: hex(signAdminRootRotation(r, oldRoot)),
  };
}

function laneFetch(state: { lane: unknown[]; keyEpoch: number }): typeof fetch {
  return (async () => new Response(JSON.stringify({ username: U, keyEpoch: state.keyEpoch, lane: state.lane }), { status: 200 })) as unknown as typeof fetch;
}

function hooks() {
  const calls: string[] = [];
  const h: AccountKeyRotationHooks & { calls: string[] } = {
    calls,
    reissueStableIds: async (o, n) => (calls.push(`reissue ${o.slice(0, 4)}>${n.slice(0, 4)}`), 2),
    persistIrk: async (n) => void calls.push(`persist ${n.slice(0, 4)}`),
    clearOwnerSessions: async () => (calls.push("sessions"), 3),
    discardArchiveKeys: async () => (calls.push("archive-keys"), 5),
    note: (kind) => void calls.push(kind),
    restart: () => void calls.push("restart"),
  };
  return h;
}

function setup(start: Account, root: Keypair) {
  const dir = mkdtempSync(join(tmpdir(), "akr-"));
  const pinPath = join(dir, "account-key-pin.json");
  const state = { lane: [] as unknown[], keyEpoch: 0 };
  const gate = new AccountKeyEpochGate();
  gate.arm();
  const h = hooks();
  const opts = {
    username: U,
    configIrkPubHex: hex(start.irk.publicKey),
    configAidPubHex: hex(start.aid.publicKey),
    adminRootSeedHex: hex(root.publicKey),
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl: laneFetch(state),
    pinStore: fileAccountKeyPinStore(pinPath, () => NOW),
    gate,
    hooks: h,
    now: () => NOW,
  };
  return { opts, state, gate, h, pinPath };
}

describe("account-key rotation on the box", () => {
  it("pins epoch 0 on an unrotated account, then adopts a verified hop without a re-pair", async () => {
    const a0 = account(), a1 = account(), root = kp();
    const t = setup(a0, root);
    expect(await pollAccountKeyRotations(t.opts)).toEqual({ kind: "no-change", epoch: 0 });
    expect(t.gate.ownerKeyHeld()).toBe(false);

    t.state.lane = [hop(a0, a1, root, 0)];
    t.state.keyEpoch = 1;
    expect(await pollAccountKeyRotations(t.opts)).toEqual({ kind: "rotated", fromEpoch: 0, toEpoch: 1 });
    expect(t.h.calls).toEqual([
      `reissue ${hex(a0.irk.publicKey).slice(0, 4)}>${hex(a1.irk.publicKey).slice(0, 4)}`,
      `persist ${hex(a1.irk.publicKey).slice(0, 4)}`,
      "sessions",
      "archive-keys",
      "account.key.rotated",
      "restart",
    ]);
    const pinned = await resolvePinnedAccountKeys(t.opts.pinStore);
    expect(pinned).toMatchObject({ epoch: 1, irkPubHex: hex(a1.irk.publicKey), aidPubHex: hex(a1.aid.publicKey) });
    expect(pinned !== "lost" && pinned?.rekeyDue).toContain("luks");
    expect(t.gate.status()).toMatchObject({ trustedEpoch: 1, holdingOwnerKey: false, capability: "account-key-rotation/v1" });
  });

  it("refuses a hop signed by the old IRK, or by a root it does not pin, and holds the old key while .com says the epoch moved", async () => {
    const a0 = account(), a1 = account(), root = kp();
    for (const signer of [a0.irk, kp()]) {
      const t = setup(a0, root);
      await pollAccountKeyRotations(t.opts);
      t.state.lane = [hop(a0, a1, root, 0, signer)];
      t.state.keyEpoch = 1;
      const out = await pollAccountKeyRotations(t.opts);
      expect(out.kind).toBe("error");
      expect(t.h.calls).toEqual([]);
      expect(t.gate.ownerKeyHeld()).toBe(true);
      expect((await resolvePinnedAccountKeys(t.opts.pinStore)) as { epoch: number }).toMatchObject({ epoch: 0, irkPubHex: hex(a0.irk.publicKey) });
    }
  });

  it("replays two hops with an admin-root rotation between them in one pass", async () => {
    const a0 = account(), a1 = account(), a2 = account(), r0 = kp(), r1 = kp();
    const t = setup(a0, r0);
    await pollAccountKeyRotations(t.opts);
    t.state.lane = [hop(a0, a1, r0, 0), rootHop(r0, r1), hop(a1, a2, r1, 1)];
    t.state.keyEpoch = 2;
    expect(await pollAccountKeyRotations(t.opts)).toEqual({ kind: "rotated", fromEpoch: 0, toEpoch: 2 });
    expect(await resolvePinnedAccountKeys(t.opts.pinStore)).toMatchObject({ epoch: 2, irkPubHex: hex(a2.irk.publicKey) });
    expect(t.h.calls.filter((c) => c.startsWith("reissue"))).toHaveLength(2);
  });

  it("places a box created after a rotation (its recipe already holds the new key) and an old seed root", async () => {
    const a0 = account(), a1 = account(), r0 = kp(), r1 = kp();
    const lane = parseLane([hop(a0, a1, r0, 0), rootHop(r0, r1)])!;
    const placed = placeOnLane({ username: U, lane, trustedIrkPubHex: hex(a1.irk.publicKey), trustedAidPubHex: null, adminRootSeedHex: hex(r0.publicKey) });
    expect(placed).toMatchObject({ index: 1, start: { epoch: 1, adminRootPubHex: hex(r0.publicKey), aidPubHex: hex(a1.aid.publicKey) } });
    expect(placeOnLane({ username: U, lane, trustedIrkPubHex: hex(account().irk.publicKey), trustedAidPubHex: null, adminRootSeedHex: hex(r0.publicKey) })).toBeNull();
  });

  it("fails closed on a lost pin and rebuilds it from the box's own key", async () => {
    const a0 = account(), a1 = account(), root = kp();
    const t = setup(a1, root);
    t.state.lane = [hop(a0, a1, root, 0)];
    t.state.keyEpoch = 1;
    writeFileSync(t.pinPath, "{ not json");
    expect(await resolvePinnedAccountKeys(t.opts.pinStore)).toBe("lost");
    t.gate.setTrusted(null);
    expect(t.gate.ownerKeyHeld()).toBe(true);
    // Lost again on the next read (the marker), then placed from the config's (rotated) key.
    expect(await pollAccountKeyRotations(t.opts)).toEqual({ kind: "no-change", epoch: 1 });
    expect(t.gate.ownerKeyHeld()).toBe(false);
    expect(await resolvePinnedAccountKeys(t.opts.pinStore)).toMatchObject({ epoch: 1 });
  });

  it("an epoch hint only ever holds the key back, never moves it", async () => {
    const g = new AccountKeyEpochGate();
    expect(g.ownerKeyHeld()).toBe(false);
    g.arm();
    g.setTrusted(2);
    g.hint(1);
    expect(g.ownerKeyHeld()).toBe(false);
    g.hint(3);
    expect(g.ownerKeyHeld()).toBe(true);
    g.hint(0);
    expect(g.ownerKeyHeld()).toBe(true);
    await expect(g.guard(async () => "claimed")).rejects.toThrow(/account key is changing/);
    g.setTrusted(3);
    expect(await g.guard(async () => "claimed")).toBe("claimed");
  });

  it("refuses an account-key-signed order while the key is held", async () => {
    const owner = kp();
    let held = true;
    const handler = buildOrdersHandler({
      serverFqdn: "home.alice.flagship.services",
      pskPub: owner.publicKey,
      ownerKeyHeld: () => held,
      executor: { addPairedSession: async () => {} } as never,
      now: () => NOW,
    });
    const order = { type: "noop", serverId: "home.alice.flagship.services", issuedAt: NOW };
    const body = Buffer.from(JSON.stringify({ request: order, signature: "00".repeat(64) }));
    const res = await handler({ method: "POST", path: "/api/orders", headers: {}, body } as never);
    expect(res.status).toBe(409);
    expect(JSON.parse(String(res.body)).code).toBe("account-key-changing");
    held = false;
    expect((await handler({ method: "POST", path: "/api/orders", headers: {}, body } as never)).status).toBe(403);
  });

  it("an admin-pinned box takes no old-IRK re-pair proof, but a hop it verified to the same key", async () => {
    const o = kp(), n = kp();
    const claim = { username: U, newIrkPub: n.publicKey, oldIrkPub: o.publicKey, issuedAt: 5_000 };
    const row = {
      newIrkPub: hex(n.publicKey), oldIrkPub: hex(o.publicKey), initiatedAt: 5_000, completesAt: 9_000, objectedAt: null,
      proof: { issuedAt: 5_000, newIrkSignature: hex(signRePairInitiate(claim, n)), oldIrkSignature: hex(signRePairInitiate(claim, o)) },
    };
    expect(await verifyRePairSwap({ row, username: U, currentIrkPubHex: hex(o.publicKey) })).toBe("proof");
    expect(await verifyRePairSwap({ row, username: U, currentIrkPubHex: hex(o.publicKey), acceptOldIrkProof: false })).toBeNull();
    expect(await verifyRePairSwap({ row, username: U, currentIrkPubHex: hex(o.publicKey), acceptOldIrkProof: false, accountKeyHopTo: async (k) => k === hex(n.publicKey) })).toBe("rotation");
    expect(await verifyRePairSwap({ row, username: U, currentIrkPubHex: hex(o.publicKey), acceptOldIrkProof: false, accountKeyHopTo: async () => false })).toBeNull();
  });

  it("the doorbell hands its key epoch to the gate, and a changed lane stamp rings", () => {
    const bell = new Doorbell({ serverDomain: "home.alice.flagship.services", username: U, fetchImpl: (async () => new Response("{}")) as never });
    const seen: number[] = [];
    let rung = 0;
    bell.onKeyEpoch((e) => seen.push(e));
    bell.onRing("keyRotations", () => rung++);
    bell.update({ v: 1, lanes: [], stamps: { aliases: "a", grants: "g", rotations: "r", keyRotations: "k1" }, keyEpoch: 0 });
    bell.update({ v: 1, lanes: [], stamps: { aliases: "a", grants: "g", rotations: "r", keyRotations: "k2" }, keyEpoch: 1 });
    // An older `.com`: no key stamp, no epoch.
    bell.update({ v: 1, lanes: [], stamps: { aliases: "a", grants: "g", rotations: "r" } });
    expect(seen).toEqual([0, 1]);
    expect(rung).toBe(2);
  });
});
