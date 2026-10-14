import { describe, expect, it } from "vitest";
import { ed, signDaemonStatusReport, signServerOrder, type Keypair, type ServerOrder } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handlePostServerOrder, readServerOrder, type ServerOrderDeps } from "../src/serverOrder.js";
import { buildPodInventory, handlePostDaemonStatus } from "../src/podInventory.js";
import { handleUserStream } from "../src/userStream.js";

const U = "plucky-avocet";
const NOW = 1_900_000_000_000;

function key(seed: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function harness(opts: { adminRoot?: Keypair } = {}) {
  const storage = new InMemoryStorage();
  const irk = key(1);
  const stks = [key(10), key(20), key(30)];
  await storage.usernames.put({
    username: U,
    irkPubHex: hex(irk.publicKey),
    ...(opts.adminRoot ? { adminRootPubHex: hex(opts.adminRoot.publicKey) } : {}),
    claimedAt: 1,
  });
  for (const [i, k] of stks.entries()) {
    await storage.servers.put({
      serverDomain: `s${i}.${U}.flagship.services`,
      username: U,
      identityPubKeyHex: hex(k.publicKey),
      registeredAt: 1,
    });
  }
  await storage.servers.put({
    serverDomain: `x.someone.flagship.services`,
    username: "someone",
    identityPubKeyHex: hex(key(40).publicKey),
    registeredAt: 1,
  });
  const deps: ServerOrderDeps = {
    usernames: storage.usernames,
    servers: storage.servers,
    serverOrders: storage.serverOrders,
    grants: storage.deviceCapabilityGrants,
    now: () => NOW,
  };
  return { storage, deps, irk, stks };
}

function body(signer: Keypair, stks: string[], over: Partial<ServerOrder> = {}) {
  const order: ServerOrder = { user: U, stks, issuedAt: NOW, nonce: "ab".repeat(32), ...over };
  return { order, signature: signServerOrder(order, signer) };
}

describe("POST /api/accounts/<u>/server-order", () => {
  it("stores a signed order and relays it on /pods and in the heartbeat reply", async () => {
    const h = await harness();
    const order = [h.stks[2]!, h.stks[0]!].map((k) => hex(k.publicKey));
    const r = await handlePostServerOrder(h.deps, U, body(h.irk, order));
    expect(r.status).toBe(200);
    expect((await readServerOrder(h.storage.serverOrders, U))?.order.stks).toEqual(order);
    const inv = await buildPodInventory(
      { daemonStatus: h.storage.daemonStatus, servers: h.storage.servers, routing: h.storage.routing, serverOrders: h.storage.serverOrders, now: () => NOW },
      U,
    );
    expect(inv.serverOrder?.order.stks).toEqual(order);
    const report = {
      serverDomain: `s0.${U}.flagship.services`,
      certSha256: null,
      certValidUntil: null,
      certIssuer: null,
      appsServed: [],
      nonce: "n1",
      issuedAt: NOW,
    };
    const beat = await handlePostDaemonStatus(
      { daemonStatus: h.storage.daemonStatus, servers: h.storage.servers, routing: h.storage.routing, serverOrders: h.storage.serverOrders },
      { request: report, signature: hex(signDaemonStatusReport(report, h.stks[0]!)) },
    );
    expect(beat.status).toBe(200);
    expect((beat.body as { serverOrder?: { order: ServerOrder } }).serverOrder?.order.stks).toEqual(order);
  });

  it("rides /stream, and a reorder answers a held stream at once", async () => {
    const h = await harness();
    const inv = { daemonStatus: h.storage.daemonStatus, servers: h.storage.servers, routing: h.storage.routing, serverOrders: h.storage.serverOrders, now: () => NOW };
    const first = await handleUserStream(inv, U, null);
    expect(first.body.serverOrder).toBeNull();
    await handlePostServerOrder(h.deps, U, body(h.irk, [hex(h.stks[1]!.publicKey)]));
    const next = await handleUserStream({ ...inv, sleep: async () => {}, maxHoldMs: 0 }, U, first.body.cursor);
    expect(next.body.cursor).not.toBe(first.body.cursor);
    expect(next.body.serverOrder?.order.stks).toEqual([hex(h.stks[1]!.publicKey)]);
  });

  it("keeps only newer orders", async () => {
    const h = await harness();
    const order = [hex(h.stks[0]!.publicKey)];
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, order))).status).toBe(200);
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, order, { issuedAt: NOW - 1000 }))).status).toBe(409);
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, order, { issuedAt: NOW + 1000 }))).status).toBe(200);
  });

  it("refuses a stale order, another account's order, and a server the account doesn't own", async () => {
    const h = await harness();
    const mine = hex(h.stks[0]!.publicKey);
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, [mine], { issuedAt: NOW - 10 * 60_000 }))).status).toBe(403);
    expect((await handlePostServerOrder(h.deps, "someone", body(h.irk, [mine]))).status).toBe(403);
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, [mine, hex(key(40).publicKey)]))).status).toBe(403);
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, [mine, "cd".repeat(32)]))).status).toBe(403);
  });

  it("refuses a revoked server", async () => {
    const h = await harness();
    await h.storage.servers.revoke(`s1.${U}.flagship.services`, "lost", NOW);
    const r = await handlePostServerOrder(h.deps, U, body(h.irk, [hex(h.stks[1]!.publicKey)]));
    expect(r.status).toBe(403);
  });

  it("refuses a bad signature and a malformed body", async () => {
    const h = await harness();
    const order = [hex(h.stks[0]!.publicKey)];
    expect((await handlePostServerOrder(h.deps, U, body(key(99), order))).status).toBe(403);
    expect((await handlePostServerOrder(h.deps, U, { order: { user: U, stks: [] } })).status).toBe(400);
  });

  it("needs the admin root once one is pinned (the IRK no longer suffices)", async () => {
    const admin = key(64);
    const h = await harness({ adminRoot: admin });
    const order = [hex(h.stks[0]!.publicKey)];
    expect((await handlePostServerOrder(h.deps, U, body(h.irk, order))).status).toBe(403);
    expect((await handlePostServerOrder(h.deps, U, body(admin, order))).status).toBe(200);
  });
});
