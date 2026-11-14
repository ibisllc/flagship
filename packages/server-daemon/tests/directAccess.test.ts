import https from "node:https";
import net from "node:net";
import type os from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDirectAddressUpdate,
  checkLanHintV2,
  ed,
  signDirectAccessOrder,
  verifyDirectAccessOrder,
  type DirectAccessOrder,
} from "@flagship/protocol";
import {
  buildDirectAccessHttp,
  buildSignedLanHintV2,
  DirectAccessController,
  publicInterfaceAddresses,
} from "../src/directAccess.js";
import { lanSourceCountsAsLan, leafCertSha256, startLanListener, type LanListener } from "../src/lanDirect.js";
import { cameViaLan, LanIngressPorts, refuseRescueOffLan } from "../src/lanIngress.js";
import { _handleHttpConnectionForTest, type HttpRequest } from "../src/runtime.js";
import { selfSigned } from "./helpers/selfSignedTls.js";

const SERVER = "home.alice.flagship.services";
const kp = (fill: number) => {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const admin = kp(0x5a);
const irk = kp(0x2a);
const stk = kp(0x31);
const otherStk = kp(0x32);
const NOW = 1_790_000_000_000;

const iface = (address: string, internal = false) =>
  ({ address, internal, family: address.includes(":") ? "IPv6" : "IPv4" }) as os.NetworkInterfaceInfo;
const IFACES = {
  lo: [iface("127.0.0.1", true)],
  eth0: [iface("192.168.1.20"), iface("2a02:8010:6400:7::1"), iface("2a02:8010:6401::9"), iface("fe80::1")],
  docker0: [iface("2a02:8010:6400:99::1")],
};

const order = (patch: Partial<DirectAccessOrder> = {}): DirectAccessOrder => ({
  serverDomain: SERVER,
  enabled: true,
  addresses: ["81.2.69.142"],
  prefixes: ["2a02:8010:6400::/48"],
  port: 443,
  issuedAt: NOW,
  ...patch,
});
const signed = (o: DirectAccessOrder, key = admin) => ({ order: o, signatureHex: Buffer.from(signDirectAccessOrder(o, key)).toString("hex") });

function controller(opts: { adminPinned?: boolean; statePath?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "direct-"));
  const activity: string[] = [];
  const c = new DirectAccessController({
    serverDomain: SERVER,
    authority: () => ({ ownerIrkPub: irk.publicKey, ...(opts.adminPinned === false ? {} : { adminRootPub: admin.publicKey }), username: "alice", activeGrants: [] }),
    statePath: opts.statePath ?? join(dir, "direct-access.json"),
    interfaces: () => IFACES,
    now: opts.now ?? (() => NOW + 1_000),
    activity: (kind) => activity.push(kind),
  });
  return { c, activity, dir };
}

describe("publicInterfaceAddresses", () => {
  it("keeps only public addresses on real interfaces", () => {
    expect(publicInterfaceAddresses(IFACES).sort()).toEqual(["2a02:8010:6400:7::1", "2a02:8010:6401::9"]);
  });
});

describe("DirectAccessController", () => {
  it("is off until the owner's order arrives, then binds only what the order allows", async () => {
    const { c, activity } = controller();
    expect(c.view().on).toBe(false);
    expect(c.listenAddresses()).toEqual([]);
    const r = await c.take(signed(order()));
    expect(r).toMatchObject({ ok: true, change: "on" });
    expect(c.listenAddresses()).toEqual(["2a02:8010:6400:7::1"]);
    expect(c.endpoints()).toEqual([
      { address: "2a02:8010:6400:7::1", port: 443 },
      { address: "81.2.69.142", port: 443 },
    ]);
    expect(activity).toEqual(["server.direct-access.on"]);
  });

  it("refuses unsigned, forged and IRK-signed orders on an admin-pinned box", async () => {
    const { c } = controller();
    expect(await c.take({ order: order() })).toMatchObject({ ok: false, status: 400 });
    expect(await c.take({ order: order(), signatureHex: "00".repeat(64) })).toMatchObject({ ok: false, status: 403, code: "not-admin" });
    const forged = { ...signed(order()), order: order({ addresses: ["8.8.8.8"] }) };
    expect(await c.take(forged)).toMatchObject({ ok: false, status: 403 });
    expect(await c.take(signed(order(), irk))).toMatchObject({ ok: false, status: 403 });
    expect(c.view().on).toBe(false);
  });

  it("takes the IRK only on a box that pins no admin root", async () => {
    const { c } = controller({ adminPinned: false });
    expect(await c.take(signed(order(), irk))).toMatchObject({ ok: true });
  });

  it("refuses private addresses, another server, replays and a far clock", async () => {
    const { c } = controller();
    const priv = order({ addresses: ["192.168.1.20"] });
    const privSigned = { order: priv, signatureHex: Buffer.from(ed.sign(new TextEncoder().encode("x"), admin.privateKey)).toString("hex") };
    expect(await c.take(privSigned)).toMatchObject({ ok: false, status: 422, code: "private-address" });
    expect(await c.take(signed(order({ serverDomain: "home.bob.flagship.services" })))).toMatchObject({ ok: false, code: "wrong-server" });
    expect(await c.take(signed(order({ issuedAt: NOW - 3_600_000 })))).toMatchObject({ ok: false, code: "stale" });
    expect(await c.take(signed(order()))).toMatchObject({ ok: true });
    expect(await c.take(signed(order()))).toMatchObject({ ok: false, status: 409, code: "replayed" });
  });

  it("turns off with an off order and voids what it served", async () => {
    const { c, activity } = controller();
    await c.take(signed(order()));
    const off = order({ enabled: false, addresses: [], prefixes: [], issuedAt: NOW + 10 });
    expect(await c.take(signed(off))).toMatchObject({ ok: true, change: "off" });
    expect(c.view()).toMatchObject({ on: false, endpoints: [] });
    expect(c.addressUpdate((m) => ed.sign(m, stk.privateKey))).toBeNull();
    expect(activity).toEqual(["server.direct-access.on", "server.direct-access.off"]);
  });

  it("keeps the order across a restart, and fails closed on a damaged file", async () => {
    const { c, dir } = controller();
    await c.take(signed(order()));
    const path = join(dir, "direct-access.json");
    const again = controller({ statePath: path }).c;
    await again.start();
    expect(again.view().on).toBe(true);
    writeFileSync(path, "{not json");
    const damaged = controller({ statePath: path }).c;
    await damaged.start();
    expect(damaged.view().on).toBe(false);
    expect(await damaged.take(signed(order()))).toMatchObject({ ok: false, code: "replayed" });
  });

  it("drops a saved order that no longer verifies (the admin root rotated)", async () => {
    const { c, dir } = controller();
    await c.take(signed(order()));
    const rotated = new DirectAccessController({
      serverDomain: SERVER,
      authority: () => ({ ownerIrkPub: irk.publicKey, adminRootPub: kp(0x77).publicKey, username: "alice" }),
      statePath: join(dir, "direct-access.json"),
      interfaces: () => IFACES,
      now: () => NOW + 2_000,
    });
    await rotated.start();
    expect(rotated.view().on).toBe(false);
  });

  it("signs an address update a verifier accepts against the order, and another box's fails", async () => {
    const { c } = controller();
    const o = order();
    await c.take(signed(o));
    const u = c.addressUpdate((m) => ed.sign(m, stk.privateKey))!;
    expect(u.update.addresses).toEqual(["2a02:8010:6400:7::1", "81.2.69.142"]);
    const expect_ = { serverDomain: SERVER, now: NOW + 5_000 };
    expect(checkDirectAddressUpdate(u.update, Buffer.from(u.signatureHex, "hex"), stk.publicKey, o, expect_)).toEqual({ ok: true });
    expect(checkDirectAddressUpdate(u.update, Buffer.from(u.signatureHex, "hex"), otherStk.publicKey, o, expect_)).toMatchObject({ ok: false, reason: "bad-signature" });
    expect(c.addressUpdate((m) => ed.sign(m, stk.privateKey))).toEqual(u);
  });
});

describe("hint v2", () => {
  const cert = async () => (await selfSigned(SERVER)).cert;

  it("carries no public endpoint without the owner's order", async () => {
    const { c } = controller();
    const certPem = await cert();
    const h = buildSignedLanHintV2({ serverDomain: SERVER, certPem, lan: [{ address: "192.168.1.20", port: 443 }], direct: c, sign: (m) => ed.sign(m, stk.privateKey), now: NOW })!;
    expect(h.hint.direct).toEqual([]);
    expect(h.hint.orderSha256).toBe("");
    expect(h.directAccess).toBeUndefined();
  });

  it("carries the order, and a device that verified it uses the public endpoints", async () => {
    const { c } = controller();
    await c.take(signed(order()));
    const certPem = await cert();
    const h = buildSignedLanHintV2({ serverDomain: SERVER, certPem, lan: [{ address: "192.168.1.20", port: 443 }], direct: c, sign: (m) => ed.sign(m, stk.privateKey), now: NOW })!;
    expect(h.hint.direct.map((e) => e.address)).toEqual(["2a02:8010:6400:7::1", "81.2.69.142"]);
    const ord = h.directAccess!.order;
    expect(verifyDirectAccessOrder(ord, Buffer.from(h.directAccess!.signatureHex, "hex"), admin.publicKey)).toBe(true);
    const expect_ = { serverDomain: SERVER, certSha256: leafCertSha256(certPem)!, now: NOW + 1 };
    expect(checkLanHintV2(h.hint, Buffer.from(h.signatureHex, "hex"), stk.publicKey, expect_, ord)).toEqual({ ok: true, useDirect: true });
    expect(checkLanHintV2(h.hint, Buffer.from(h.signatureHex, "hex"), stk.publicKey, expect_, null)).toEqual({ ok: true, useDirect: false });
  });
});

describe("HTTP", () => {
  const req = (method: string, body?: unknown): HttpRequest => ({ method, path: "/api/screens/direct-access", headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });

  it("reads the view, takes an order, refuses companions, and answers 204 for the address while off", async () => {
    const { c } = controller();
    let companion = false;
    const http = buildDirectAccessHttp({
      controller: c,
      denyCompanion: () => (companion ? { status: 403, headers: {}, body: "companion" } : null),
      sign: (m) => ed.sign(m, stk.privateKey),
      lanHintV2: () => null,
    });
    expect((await http("/api/screens/direct-access/address", "GET", req("GET")))!.status).toBe(204);
    expect((await http("/api/screens/lan-hint/v2", "GET", req("GET")))!.status).toBe(204);
    companion = true;
    expect((await http("/api/screens/direct-access", "POST", req("POST", signed(order()))))!.status).toBe(403);
    companion = false;
    const ok = await http("/api/screens/direct-access", "POST", req("POST", signed(order())));
    expect(ok!.status).toBe(200);
    expect(JSON.parse(ok!.body as string)).toMatchObject({ ok: true, change: "on", directAccess: { on: true } });
    const addr = await http("/api/screens/direct-access/address", "GET", req("GET"));
    expect(JSON.parse(addr!.body as string).directAccess.order.addresses).toEqual(["81.2.69.142"]);
    const bad = await http("/api/screens/direct-access", "POST", req("POST", { order: order({ issuedAt: NOW + 5 }), signatureHex: "00".repeat(64) }));
    expect(bad!.status).toBe(403);
    expect(JSON.parse(bad!.body as string).code).toBe("not-admin");
    expect(await http("/api/screens/other", "GET", req("GET"))).toBeNull();
  });
});

describe("ingress marking", () => {
  it("a public IPv4 source on the LAN listener (a port forward) is not LAN", () => {
    expect(lanSourceCountsAsLan("192.168.1.9")).toBe(true);
    expect(lanSourceCountsAsLan("::ffff:10.0.0.4")).toBe(true);
    expect(lanSourceCountsAsLan("127.0.0.1")).toBe(true);
    expect(lanSourceCountsAsLan("fd12::5")).toBe(true);
    expect(lanSourceCountsAsLan("2a02:8010:6400:7::5")).toBe(true);
    expect(lanSourceCountsAsLan("81.2.69.142")).toBe(false);
    expect(lanSourceCountsAsLan("::ffff:81.2.69.142")).toBe(false);
    expect(lanSourceCountsAsLan(undefined)).toBe(false);
  });

  describe("over real TLS", () => {
    let server: tls.Server;
    let listener: LanListener | null = null;
    afterEach(async () => {
      await listener?.close();
      listener = null;
      await new Promise<void>((r) => server.close(() => r()));
    });

    it("the public listener reaches the box, but never its LAN-only rescue routes", async () => {
      const material = await selfSigned(SERVER);
      const ports = new LanIngressPorts();
      server = tls.createServer({ cert: material.cert, key: material.key }, (socket) => {
        const viaLan = cameViaLan(socket, ports);
        _handleHttpConnectionForTest(socket, async (r) => refuseRescueOffLan(r, viaLan) ?? { status: 200, headers: { "content-type": "text/plain" }, body: `ok:${r.path}` });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const backendPort = (server.address() as net.AddressInfo).port;
      listener = await startLanListener({ port: 0, backendPort, zone: SERVER, listAddresses: () => ["127.0.0.1"], log: () => {}, lanPorts: ports, ingress: "public" });
      const port = listener.endpoints()[0]!.port;
      const post = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const r = https.request({ host: "127.0.0.1", port, path, method: "POST", servername: SERVER, rejectUnauthorized: false, agent: false, headers: { host: SERVER } }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          r.on("error", reject);
          r.end();
        });
      expect(await post("/api/health")).toEqual({ status: 200, body: "ok:/api/health" });
      expect(await post("/api/rescue/hello")).toEqual({ status: 404, body: "not found" });
    });
  });
});
