// Failure handling for the owner's proxy and our relay (docs/outbound-proxy.md
// "Failure handling"): proxy down, proxy password refused, the hub refused,
// relay down, gateway down, and recovery from each.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decapsulateOhttpRequest,
  decodeBhttpRequest,
  deriveIRK,
  ed,
  encapsulateOhttpResponse,
  encodeBhttpResponse,
  encodeOhttpKeyConfig,
  ohttpGatewayKey,
  signBoxProxy,
  type BoxProxy,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { buildPodInventory, handleGetProxyOrder, handlePostProxyAlert, handlePostProxyOrder } from "@flagship/control-plane";
import { OutboundNet } from "../src/outboundProxy/outboundNet.js";
import { OutboundProxyStore, settingOf, type StoredOutboundProxy } from "../src/outboundProxy/store.js";
import { startProxyLane } from "../src/outboundProxy/lane.js";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
async function deadPort(): Promise<number> {
  const s = createServer();
  const p = await listen(s);
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** SOCKS5 with a username/password; `refuse` hosts get a "connection not allowed" reply. */
async function socks5(creds: { u: string; p: string } | null, refuse: string[] = []) {
  const s = createServer((c: Socket) => {
    let buf = Buffer.alloc(0);
    let stage = "greet";
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === "greet" && buf.length >= 2 && buf.length >= 2 + buf[1]!) {
        buf = buf.subarray(2 + buf[1]!);
        c.write(Buffer.from([5, creds ? 2 : 0]));
        stage = creds ? "auth" : "req";
      }
      if (stage === "auth" && buf.length >= 2) {
        const ul = buf[1]!;
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul]!;
        if (buf.length < 3 + ul + pl) return;
        const ok = buf.subarray(2, 2 + ul).toString() === creds!.u && buf.subarray(3 + ul, 3 + ul + pl).toString() === creds!.p;
        buf = buf.subarray(3 + ul + pl);
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return void c.end();
        stage = "req";
      }
      if (stage === "req" && buf.length >= 5) {
        const host = buf.subarray(5, 5 + buf[4]!).toString();
        stage = "done";
        if (refuse.includes(host)) return void c.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      }
    });
  });
  const port = await listen(s);
  closers.push(() => s.close());
  return port;
}

describe("the owner's proxy failing", () => {
  it("proxy down: failing with code unreachable, then back to ok when it returns", async () => {
    const dead = await deadPort();
    const net = new OutboundNet({ connectTimeoutMs: 2000 });
    const seen: Array<[string, string]> = [];
    net.onStateChange((s, prev, how) => {
      if (!how.configured) seen.push([prev.state, `${s.state}:${s.code ?? ""}`]);
    });
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: dead }, fallbackDirect: false });
    await expect(net.connectTcp("hub.example", 8443)).rejects.toMatchObject({ code: "unreachable" });
    expect(net.status()).toMatchObject({ state: "failing", code: "unreachable" });
    // the same failure again is not a new event
    await expect(net.connectTcp("hub.example", 8443)).rejects.toBeTruthy();
    // The proxy comes back on the same address: the next connection works and says so.
    const live = await socks5(null);
    (net as unknown as { open: unknown }).open = (up: { host: string }, h: string, p: number, t: number) =>
      import("../src/outboundProxy/connect.js").then((m) => m.openProxiedSocket({ ...up, kind: "socks5", port: live } as never, h, p, t));
    (await net.connectTcp("hub.example", 8443)).destroy();
    expect(net.status().state).toBe("ok");
    expect(seen).toEqual([
      ["ok", "failing:unreachable"],
      ["failing", "ok:"],
    ]);
  });

  it("password refused: failing with code auth; a fixed password recovers", async () => {
    const port = await socks5({ u: "alice", p: "right" });
    const net = new OutboundNet({ connectTimeoutMs: 2000 });
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port, username: "alice", password: "wrong" }, fallbackDirect: false });
    await expect(net.connectTcp("hub.example", 8443)).rejects.toMatchObject({ code: "auth" });
    expect(net.status()).toMatchObject({ state: "failing", code: "auth" });
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port, username: "alice", password: "right" }, fallbackDirect: false });
    (await net.connectTcp("hub.example", 8443)).destroy();
    expect(net.status().state).toBe("ok");
  });

  it("a proxy that refuses the hub counts as failing; refusing another host doesn't", async () => {
    const port = await socks5(null, ["hub.example", "blocked.example"]);
    const net = new OutboundNet({ connectTimeoutMs: 2000 });
    net.setCriticalHosts(["hub.example"]);
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port }, fallbackDirect: false });
    await expect(net.connectTcp("blocked.example", 443)).rejects.toMatchObject({ code: "refused" });
    expect(net.status().state).toBe("ok");
    await expect(net.connectTcp("hub.example", 8443)).rejects.toMatchObject({ code: "refused" });
    expect(net.status()).toMatchObject({ state: "failing", code: "refused" });
  });

  it("with fallbackDirect the box goes direct and says fallback with the reason", async () => {
    const dead = await deadPort();
    const target = createHttpServer((_q, r) => r.end("ok"));
    const tport = await listen(target);
    closers.push(() => target.close());
    const net = new OutboundNet({ connectTimeoutMs: 2000 });
    (net as unknown as { direct: (h: string, p: number) => Promise<Socket> }).direct = ((orig) => (_h: string, _p: number) =>
      orig("127.0.0.1", tport))((net as unknown as { direct: (h: string, p: number) => Promise<Socket> }).direct.bind(net));
    net.configure({ upstream: { kind: "socks5", host: "127.0.0.1", port: dead }, fallbackDirect: true });
    (await net.connectTcp("hub.example", 8443)).destroy();
    expect(net.status()).toMatchObject({ state: "fallback", code: "unreachable" });
  });
});

// ── the lane, against an in-process .com, relay and gateway ──────────────────

const U = "plucky-avocet";
const D = `home.${U}.flagship.services`;
const NOW = Date.now();
const irk = deriveIRK({ seed: new Uint8Array(32).fill(0x2a) });
const stkPriv = new Uint8Array(32).fill(7);
const stkPub = ed.getPublicKey(stkPriv);
const gw = ohttpGatewayKey(3, new Uint8Array(32).fill(0x31));
const keyHex = Buffer.from(encodeOhttpKeyConfig(gw)).toString("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: U, irkPubHex: hex(irk.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: D, username: U, identityPubKeyHex: hex(stkPub), registeredAt: 1 });
  const pushes: unknown[] = [];
  const laneDeps = {
    lane: storage.boxProxyLane,
    servers: storage.servers,
    usernames: storage.usernames,
    pushTokens: { listByUser: async () => [{ tokenId: "t", platform: "apns", providerToken: "x" }] } as never,
    pushFanout: async (a: { payload: unknown }) => void pushes.push(a.payload),
  };
  const relay = { down: false, gatewayDown: false, used: 0 };
  const direct: string[] = [];
  /** `.com` itself. */
  const com = async (url: string, method: string, headers: Record<string, string>, body: Uint8Array): Promise<Response> => {
    const path = new URL(url).pathname;
    const auth = headers.authorization ?? headers.Authorization ?? null;
    const r = path.endsWith("/proxy-alert")
      ? await handlePostProxyAlert(laneDeps, D, path, auth, body)
      : method === "GET"
        ? await handleGetProxyOrder(laneDeps, D, path, auth)
        : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  type Init = { method: string; headers: Record<string, string>; body?: Uint8Array };
  /** Connections that don't use the proxy: to the relay, or directly to .com. */
  const directFetch = async (url: string, init: Init): Promise<Response> => {
    if (url.startsWith("https://relay.test")) {
      if (relay.down) throw new Error("ECONNREFUSED");
      if (relay.gatewayDown) return new Response("bad gateway", { status: 502 });
      relay.used++;
      const g = decapsulateOhttpRequest([gw], init.body!);
      const inner = decodeBhttpRequest(g.request);
      const res = await com(`https://${inner.authority}${inner.path}`, inner.method, Object.fromEntries(inner.headers), inner.body);
      const bh = encodeBhttpResponse({ status: res.status, headers: [["content-type", "application/json"]], body: new Uint8Array(await res.arrayBuffer()) });
      return new Response(encapsulateOhttpResponse(g.context, bh), { status: 200, headers: { "content-type": "message/ohttp-res" } });
    }
    direct.push(`${new URL(url).pathname}#${init.headers["x-flagship-relay-fallback"] ?? ""}`);
    return com(url, init.method, init.headers, init.body ?? new Uint8Array(0));
  };
  /** The normal path (through the proxy while it works; direct in fallback). */
  const normal: string[] = [];
  const normalFetch = async (url: string, init: Init) => {
    normal.push(new URL(url).pathname);
    return com(url, init.method, init.headers, init.body ?? new Uint8Array(0));
  };

  const d = mkdtempSync(join(tmpdir(), "proxy-lane-"));
  writeConfig(d);
  const authority = { serverDomain: D, username: U, ownerIrkPub: irk.publicKey };
  const store = new OutboundProxyStore(join(d, "outbound-proxy.json"), authority);
  const net = new OutboundNet({ connectTimeoutMs: 2000 });
  const notes: Array<[string, boolean | undefined]> = [];
  const activated: StoredOutboundProxy[] = [];
  const lane = startProxyLane({
    net,
    store,
    authority,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    signAsBox: (m) => ed.sign(m, stkPriv),
    activate: async (s) => {
      activated.push(s);
      net.configure(settingOf(s));
    },
    note: (k, _d, o) => notes.push([k, o.ok]),
    ohttpConfigPath: join(d, "ohttp-config.json"),
    probeTarget: () => ({ host: "hub.example", port: 8443 }),
    fetch: normalFetch as never,
    directFetch: directFetch as never,
    pollEveryMs: 60_000_000,
    log: () => {},
  });
  await lane.start();
  const pods = async () =>
    JSON.stringify(
      await buildPodInventory({ daemonStatus: storage.daemonStatus, servers: storage.servers, routing: storage.routing, boxProxyLane: storage.boxProxyLane }, U),
    );
  return { storage, store, net, lane, relay, direct, normal, notes, activated, pushes, pods, d };
}

function writeConfig(dir: string) {
  writeFileSync(
    join(dir, "ohttp-config.json"),
    JSON.stringify({ v: 1, keyConfigHex: keyHex, relays: [{ url: "https://relay.test/ohttp", operator: "Test relay", interim: false }] }),
  );
}

const order = (over: Partial<BoxProxy> = {}): BoxProxy => ({
  serverDomain: D,
  kind: "socks5",
  host: "127.0.0.1",
  port: 1,
  auth: false,
  fallbackDirect: false,
  issuedAt: NOW,
  nonce: "cd".repeat(32),
  ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 30));

async function failProxy(w: Awaited<ReturnType<typeof world>>) {
  const dead = await deadPort();
  const p = order({ port: dead, issuedAt: NOW - 60_000 });
  await w.store.save({ signed: { proxy: p, signature: signBoxProxy(p, irk) }, source: "owner" });
  w.net.configure(settingOf(w.store.current()));
  await expect(w.net.connectTcp("hub.example", 8443)).rejects.toBeTruthy();
  await tick();
}

describe("the lane: reports and fixes while the proxy fails", () => {
  it("relay up: the report reaches .com through the relay; /pods shows it; one push; Activity warns", async () => {
    const w = await world();
    await failProxy(w);
    expect(w.relay.used).toBeGreaterThan(0);
    expect(w.direct.filter((x) => x.includes("proxy-alert"))).toEqual([]);
    expect(await w.pods()).toContain('"proxyAlert":{"state":"failing","code":"unreachable"');
    expect(w.pushes).toHaveLength(1);
    expect(w.notes).toContainEqual(["server.proxy.failing", false]);
  });

  it("relay down: the report and the poll still get through, directly and marked", async () => {
    const w = await world();
    w.relay.down = true;
    await failProxy(w);
    expect(w.direct.some((x) => x.endsWith("/proxy-alert#relay-unreachable"))).toBe(true);
    expect(await w.pods()).toContain('"state":"failing"');
    expect(await w.lane.pollOnce()).toBe("none");
  });

  it("gateway down (relay answers 502): direct, marked relay-502; recovers through the relay when it's back", async () => {
    const w = await world();
    w.relay.gatewayDown = true;
    await failProxy(w);
    expect(w.direct.some((x) => x.endsWith("#relay-502"))).toBe(true);
    w.relay.gatewayDown = false;
    const before = w.relay.used;
    expect(await w.lane.pollOnce()).toBe("none");
    expect(w.relay.used).toBe(before + 1);
  });

  it("the owner turns the proxy off from the app while the box is offline: the lane delivers it", async () => {
    const w = await world();
    await failProxy(w);
    const off = order({ kind: "none", host: "", port: 0, issuedAt: Date.now() });
    const dep = await handlePostProxyOrder(
      { lane: w.storage.boxProxyLane, servers: w.storage.servers, usernames: w.storage.usernames },
      D,
      { proxy: off, signature: signBoxProxy(off, irk) },
    );
    expect(dep.status).toBe(200);
    expect(await w.lane.pollOnce()).toBe("applied");
    expect(w.store.current()?.signed.proxy.kind).toBe("none");
    expect(w.net.status().state).toBe("direct");
    await tick();
    // back to normal: the alert is cleared on /pods
    expect(await w.pods()).not.toContain("proxyAlert");
    expect(w.notes.map((n) => n[0])).toContain("server.proxy.changed");
  });

  it("refuses a lane order that would need a new password, and one signed by someone else", async () => {
    const w = await world();
    await failProxy(w);
    const pw = order({ host: "other.example", port: 1080, auth: true, issuedAt: Date.now() });
    await w.storage.boxProxyLane.putOrderIfNewer(D, U, { orderJson: JSON.stringify(pw), signatureHex: signBoxProxy(pw, irk), issuedAt: pw.issuedAt });
    expect(await w.lane.pollOnce()).toBe("refused");
    const forged = order({ kind: "none", host: "", port: 0, issuedAt: Date.now() + 1 });
    const other = deriveIRK({ seed: new Uint8Array(32).fill(0x55) });
    await w.storage.boxProxyLane.putOrderIfNewer(D, U, { orderJson: JSON.stringify(forged), signatureHex: signBoxProxy(forged, other), issuedAt: forged.issuedAt });
    expect(await w.lane.pollOnce()).toBe("refused");
    expect(w.store.current()?.signed.proxy.kind).toBe("socks5");
  });

  it("proxy back: Activity says so and the alert clears", async () => {
    const w = await world();
    await failProxy(w);
    expect(await w.pods()).toContain("proxyAlert");
    // The proxy comes back on the address the box holds.
    const live = await socks5(null);
    (w.net as unknown as { open: unknown }).open = (up: object, h: string, p: number, t: number) =>
      import("../src/outboundProxy/connect.js").then((m) => m.openProxiedSocket({ ...up, kind: "socks5", port: live } as never, h, p, t));
    (await w.net.connectTcp("hub.example", 8443)).destroy();
    await tick();
    expect(w.net.status().state).toBe("ok");
    expect(w.notes.map((n) => n[0])).toContain("server.proxy.ok");
    expect(await w.pods()).not.toContain("proxyAlert");
  });

});
