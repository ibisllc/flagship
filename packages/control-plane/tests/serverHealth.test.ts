import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleGetUserPods, handlePostServerHealth } from "../src/index.js";

const NOW = 1_800_000_000_000;
const DOMAIN = "home2.harry.flagship.services";
const sk = new Uint8Array(32).fill(5);
const pub = ed.getPublicKey(sk);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function report(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1, domain: DOMAIN, at: NOW - 1_000, uptimeS: 600, memTotalMB: 3900, memAvailMB: 120,
    swapUsedMB: 0, oomKills: 3, daemon: { state: "activating", restarts: 4, lastExit: 137 },
    tunnel: false, diskUsedPct: 41, ...over,
  });
}
const sign = (r: string, key = sk) => hex(ed.sign(new TextEncoder().encode(r), key));

async function setup() {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: DOMAIN, username: "harry", identityPubKeyHex: hex(pub), registeredAt: NOW - 50_000 });
  const deps = { servers: storage.servers, serverHealth: storage.serverHealth, now: () => NOW };
  return { storage, deps };
}

describe("box health reports", () => {
  it("stores a report signed by the box and relays it on /pods", async () => {
    const { storage, deps } = await setup();
    const r = report();
    const res = await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) });
    expect(res.status).toBe(200);
    const pods = await handleGetUserPods(
      { daemonStatus: storage.daemonStatus, serverHealth: storage.serverHealth, servers: storage.servers, routing: storage.routing, now: () => NOW },
      "harry",
    );
    const health = (pods.body as { pods: Array<{ health?: Record<string, unknown> }> }).pods[0]!.health;
    expect(health).toMatchObject({ oomKills: 3, memAvailMB: 120, tunnel: false, receivedAt: NOW });
    expect(health?.daemon).toEqual({ state: "activating", restarts: 4, lastExit: 137 });
  });

  it("refuses another key, another server's report, replays, stale reports and junk", async () => {
    const { deps } = await setup();
    const r = report();
    const other = new Uint8Array(32).fill(9);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r, other) })).status).toBe(403);
    const elsewhere = report({ domain: "evil.harry.flagship.services" });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: elsewhere, signature: sign(elsewhere) })).status).toBe(403);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) })).status).toBe(200);
    expect((await handlePostServerHealth(deps, DOMAIN, { report: r, signature: sign(r) })).status).toBe(403);
    const old = report({ at: NOW - 60 * 60_000 });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: old, signature: sign(old) })).status).toBe(403);
    const freeText = report({ daemon: { state: "Error: secret at /home/x", restarts: 0, lastExit: 0 } });
    expect((await handlePostServerHealth(deps, DOMAIN, { report: freeText, signature: sign(freeText) })).status).toBe(400);
    expect((await handlePostServerHealth(deps, "nobody.harry.flagship.services", { report: r, signature: sign(r) })).status).toBe(403);
  });
});
