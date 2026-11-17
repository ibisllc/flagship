// The outbound proxy's fallback lane (docs/outbound-proxy.md "Failure handling").
import { describe, expect, it } from "vitest";
import { boxProxyLaneAuth, ed, signBoxProxy, type BoxProxy, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetProxyOrder, handlePostProxyAlert, handlePostProxyOrder, type BoxProxyLaneDeps } from "../src/boxProxyLane.js";
import { buildPodInventory } from "../src/podInventory.js";

const U = "plucky-avocet";
const D = `home.${U}.flagship.services`;
const NOW = 1_900_000_000_000;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key(seed: number): Keypair {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

async function harness() {
  const storage = new InMemoryStorage();
  const irk = key(1);
  const stk = key(10);
  await storage.usernames.put({ username: U, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: D, username: U, identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  const pushes: unknown[] = [];
  const deps: BoxProxyLaneDeps = {
    lane: storage.boxProxyLane,
    servers: storage.servers,
    usernames: storage.usernames,
    grants: storage.deviceCapabilityGrants,
    pushTokens: { listByUser: async () => [{ tokenId: "t1", platform: "apns", providerToken: "tok" }] } as never,
    pushFanout: async (a) => {
      pushes.push(a.payload);
    },
    now: () => NOW,
  };
  return { storage, deps, irk, stk, pushes };
}

const order = (over: Partial<BoxProxy> = {}): BoxProxy => ({
  serverDomain: D,
  kind: "none",
  host: "",
  port: 0,
  auth: false,
  fallbackDirect: false,
  issuedAt: NOW,
  nonce: "ab".repeat(32),
  ...over,
});

describe("proxy order lane", () => {
  it("keeps an owner-signed order and hands it to the box's signed poll", async () => {
    const h = await harness();
    const p = order();
    expect((await handlePostProxyOrder(h.deps, D, { proxy: p, signature: signBoxProxy(p, h.irk) })).status).toBe(200);
    const path = `/api/server/${D}/proxy-order`;
    const auth = boxProxyLaneAuth(D, "GET", path, NOW, new Uint8Array(0), h.stk.privateKey);
    const r = await handleGetProxyOrder(h.deps, D, path, auth);
    expect(r.status).toBe(200);
    expect((r.body as { order: { proxy: BoxProxy } }).order.proxy).toEqual(p);
  });

  it("refuses a stranger's order, credentials, a stale one, an older one and an unsigned poll", async () => {
    const h = await harness();
    const p = order();
    expect((await handlePostProxyOrder(h.deps, D, { proxy: p, signature: signBoxProxy(p, key(99)) })).status).toBe(403);
    expect((await handlePostProxyOrder(h.deps, D, { proxy: p, signature: signBoxProxy(p, h.irk), credentials: { username: "a", password: "b" } })).status).toBe(400);
    const old = order({ issuedAt: NOW - 11 * 60_000 });
    expect((await handlePostProxyOrder(h.deps, D, { proxy: old, signature: signBoxProxy(old, h.irk) })).status).toBe(403);
    await handlePostProxyOrder(h.deps, D, { proxy: p, signature: signBoxProxy(p, h.irk) });
    const older = order({ issuedAt: NOW - 1000 });
    expect((await handlePostProxyOrder(h.deps, D, { proxy: older, signature: signBoxProxy(older, h.irk) })).status).toBe(409);
    const path = `/api/server/${D}/proxy-order`;
    expect((await handleGetProxyOrder(h.deps, D, path, null)).status).toBe(403);
    const wrongKey = boxProxyLaneAuth(D, "GET", path, NOW, new Uint8Array(0), key(77).privateKey);
    expect((await handleGetProxyOrder(h.deps, D, path, wrongKey)).status).toBe(403);
  });

  it("an alert shows on /pods, wakes the owner once per change, and clears", async () => {
    const h = await harness();
    const path = `/api/server/${D}/proxy-alert`;
    const send = (b: unknown) => {
      const body = new TextEncoder().encode(JSON.stringify(b));
      return handlePostProxyAlert(h.deps, D, path, boxProxyLaneAuth(D, "POST", path, NOW, body, h.stk.privateKey), body);
    };
    expect((await send({ state: "failing", code: "auth", since: NOW - 5000 })).status).toBe(200);
    await send({ state: "failing", code: "auth", since: NOW - 5000 });
    expect(h.pushes).toHaveLength(1);
    expect((h.pushes[0] as { category: string }).category).toBe("outbound-proxy");
    const pods = await buildPodInventory(
      { daemonStatus: h.storage.daemonStatus, servers: h.storage.servers, routing: h.storage.routing, boxProxyLane: h.storage.boxProxyLane },
      U,
    );
    expect(JSON.stringify(pods)).toContain('"proxyAlert":{"state":"failing","code":"auth"');
    await send({ state: "ok", since: NOW });
    const after = await buildPodInventory(
      { daemonStatus: h.storage.daemonStatus, servers: h.storage.servers, routing: h.storage.routing, boxProxyLane: h.storage.boxProxyLane },
      U,
    );
    expect(JSON.stringify(after)).not.toContain("proxyAlert");
    // a tampered body fails the signature
    const body = new TextEncoder().encode(JSON.stringify({ state: "failing", since: NOW }));
    const auth = boxProxyLaneAuth(D, "POST", path, NOW, body, h.stk.privateKey);
    expect((await handlePostProxyAlert(h.deps, D, path, auth, new TextEncoder().encode('{"state":"ok","since":1}'))).status).toBe(403);
  });
});
