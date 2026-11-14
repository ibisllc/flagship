/**
 * The box's half of direct names (docs/direct-access-and-domains.md §8): the address update sent to `.com`, the
 * names the box serves (only owner-signed ones it verifies itself), the TLS gate and app routing for them, and one
 * certificate per name through the real `.com` issuance route (sqlite D1, fake CA).
 */
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import type os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { D1Storage, type D1Database } from "@flagship/storage";
import {
  checkDirectAddressUpdate,
  ed,
  signDirectAccessOrder,
  signDirectNameOrder,
  type DirectAccessOrder,
  type DirectAddressUpdate,
  type DirectNameOrder,
} from "@flagship/protocol";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import { tryIssuanceRoute } from "../../../apps/com/src/certificateIssuance.js";
import { accountKeyPem, FakeAcme, FakeDns } from "../../../apps/com/test/support/fakeAcme.js";
import { DirectAccessController } from "../src/directAccess.js";
import { DirectNames, directNameService } from "../src/directNames.js";
import { lanSniAllowed, startLanListener, type LanListener } from "../src/lanDirect.js";
import { directApp } from "../src/runtime.js";
import { CertManager } from "../src/certManager.js";
import { PersistentAcmeStore } from "../src/acme/persistentStore.js";
import { DirectCertificates } from "../src/acme/directCertificates.js";
import { localCsrSource, ServiceIssuer } from "../src/acme/serviceIssuer.js";
import { selfSigned } from "./helpers/selfSignedTls.js";

const SERVER = "home.alice.flagship.services";
const NAME = "game--alice.fshp.app";
const kp = (fill: number) => {
  const privateKey = new Uint8Array(32).fill(fill);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};
const admin = kp(0x5a);
const irk = kp(0x2a);
const stk = kp(0x31);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW = Date.now();

const iface = (address: string) => ({ address, internal: false, family: address.includes(":") ? "IPv6" : "IPv4" }) as os.NetworkInterfaceInfo;
let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = { eth0: [iface("2a02:8010:6400:7::1")] };

const accessOrder = (): DirectAccessOrder => ({ serverDomain: SERVER, enabled: true, addresses: ["81.2.69.142"], prefixes: ["2a02:8010:6400::/48"], port: 443, issuedAt: NOW });
const nameOrder = (patch: Partial<DirectNameOrder> = {}): DirectNameOrder => ({ name: NAME, serverDomain: SERVER, enabled: true, addresses: [], caa: "pin", issuedAt: NOW, ...patch });
const nameEntry = (o: DirectNameOrder, key = admin, extra: Record<string, unknown> = {}) => ({ name: o.name, order: o, signatureHex: hex(signDirectNameOrder(o, key)), ...extra });

async function controller() {
  const dir = mkdtempSync(join(tmpdir(), "direct-names-"));
  const c = new DirectAccessController({
    serverDomain: SERVER,
    authority: () => ({ ownerIrkPub: irk.publicKey, adminRootPub: admin.publicKey, username: "alice", activeGrants: [] }),
    statePath: join(dir, "direct-access.json"),
    interfaces: () => ifaces,
    now: () => NOW + 1000,
  });
  const o = accessOrder();
  expect((await c.take({ order: o, signatureHex: hex(signDirectAccessOrder(o, admin)) })).ok).toBe(true);
  return c;
}

function harness(c: DirectAccessController, names: unknown[], opts: { pushStatus?: number } = {}) {
  const posted: Array<{ update: DirectAddressUpdate; signatureHex: string; directAccess: { order: DirectAccessOrder } }> = [];
  const reads: string[] = [];
  const d = new DirectNames({
    controller: c,
    comBaseUrl: "https://flagshipserver.com/",
    username: "alice",
    serverFqdn: SERVER,
    signAsBox: (m) => ed.sign(m, stk.privateKey),
    readFetch: async (url) => {
      reads.push(url);
      return new Response(JSON.stringify({ apex: "fshp.app", servers: [], names }), { status: 200 });
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://flagshipserver.com/api/direct-access/address");
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: opts.pushStatus ?? 200 });
    }) as typeof fetch,
    log: () => {},
  });
  return { d, posted, reads };
}

describe("the box's address update to .com", () => {
  it("sends the signed update with its order once, and again only when the addresses change", async () => {
    ifaces = { eth0: [iface("2a02:8010:6400:7::1")] };
    const c = await controller();
    const h = harness(c, []);
    expect(await h.d.pushAddress()).toBe("sent");
    const sent = h.posted[0]!;
    expect(sent.update.addresses).toEqual(["2a02:8010:6400:7::1", "81.2.69.142"]);
    expect(checkDirectAddressUpdate(sent.update, Buffer.from(sent.signatureHex, "hex"), stk.publicKey, sent.directAccess.order, { serverDomain: SERVER, now: NOW + 2000 })).toEqual({ ok: true });
    expect(await h.d.pushAddress()).toBe("unchanged");
    ifaces = { eth0: [iface("2a02:8010:6400:8::1")] };
    expect(await h.d.pushAddress()).toBe("sent");
    expect(h.posted[1]!.update.addresses).toContain("2a02:8010:6400:8::1");
    expect(h.posted.length).toBe(2);
  });

  it("keeps trying while .com refuses", async () => {
    ifaces = { eth0: [iface("2a02:8010:6400:7::1")] };
    const h = harness(await controller(), [], { pushStatus: 503 });
    expect(await h.d.pushAddress()).toBe("failed");
    expect(await h.d.pushAddress()).toBe("failed");
    expect(h.posted.length).toBe(2);
  });
});

describe("the names the box serves", () => {
  it("keeps only names whose owner-signed order names this box and verifies here", async () => {
    const c = await controller();
    const forged = nameEntry(nameOrder({ name: "forged--alice.fshp.app" }));
    forged.signatureHex = hex(signDirectNameOrder(nameOrder({ name: "other--alice.fshp.app" }), admin));
    const h = harness(c, [
      nameEntry(nameOrder()),
      nameEntry(nameOrder({ name: "irk--alice.fshp.app" }), irk),
      forged,
      nameEntry(nameOrder({ name: "elsewhere--alice.fshp.app", serverDomain: "home2.alice.flagship.services" })),
      nameEntry(nameOrder({ name: "off--alice.fshp.app", enabled: false })),
      nameEntry(nameOrder({ name: "held--alice.fshp.app" }), admin, { suspended: { at: 1, reason: "phishing" } }),
      { name: "junk", order: { name: 1 }, signatureHex: "00" },
    ]);
    const changes: string[][] = [];
    h.d.onChange((n) => changes.push([...n]));
    expect(await h.d.refreshNames()).toEqual([NAME]);
    expect(h.reads).toEqual(["https://flagshipserver.com/api/accounts/alice/direct-access"]);
    expect(h.d.has("GAME--alice.fshp.app")).toBe(true);
    expect(changes).toEqual([[NAME]]);
    await h.d.refreshNames();
    expect(changes.length).toBe(1);
  });

  it("keeps what it had when .com can't be read", async () => {
    const c = await controller();
    let fail = false;
    const d = new DirectNames({
      controller: c,
      comBaseUrl: "https://flagshipserver.com",
      username: "alice",
      serverFqdn: SERVER,
      signAsBox: (m) => ed.sign(m, stk.privateKey),
      readFetch: async () => (fail ? new Response("", { status: 503 }) : new Response(JSON.stringify({ names: [nameEntry(nameOrder())] }))),
      log: () => {},
    });
    await d.refreshNames();
    fail = true;
    expect(await d.refreshNames()).toEqual([NAME]);
  });
});

describe("TLS gate and routing for direct names", () => {
  let listener: LanListener | null = null;
  let backend: net.Server | null = null;
  afterEach(async () => {
    await listener?.close();
    backend?.close();
    listener = null;
    backend = null;
  });

  it("the gate admits exactly the box's direct names besides its own zone", () => {
    expect(lanSniAllowed(NAME, SERVER, [NAME])).toBe(true);
    expect(lanSniAllowed("other--alice.fshp.app", SERVER, [NAME])).toBe(false);
    expect(lanSniAllowed(`x.${NAME}`, SERVER, [NAME])).toBe(false);
    expect(lanSniAllowed(`app.${SERVER}`, SERVER, [NAME])).toBe(true);
    expect(lanSniAllowed(NAME, SERVER)).toBe(false);
  });

  it("a public-listener connection for a direct name reaches the TLS server; any other name is cut", async () => {
    const cert = await selfSigned(NAME);
    const server = tls.createServer({ cert: cert.cert, key: cert.key }, (s) => s.end("hello"));
    backend = server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const backendPort = (server.address() as net.AddressInfo).port;
    let names: string[] = [];
    listener = await startLanListener({ port: 0, backendPort, zone: SERVER, listAddresses: () => ["127.0.0.1"], ingress: "public", extraNames: () => names, log: () => {} });
    const port = listener.endpoints()[0]!.port;
    const connect = (servername: string) =>
      new Promise<string>((resolve) => {
        const s = tls.connect({ host: "127.0.0.1", port, servername, ca: cert.cert, rejectUnauthorized: false });
        let got = "";
        s.on("data", (b) => (got += b.toString()));
        s.on("close", () => resolve(got));
        s.on("error", () => resolve(got));
      });
    expect(await connect(NAME)).toBe("");
    names = [NAME];
    expect(await connect(NAME)).toBe("hello");
    expect(await connect("other--alice.fshp.app")).toBe("");
  });

  it("routes a held direct name to its app, and nothing else", () => {
    expect(directNameService(NAME)).toEqual({ creator: "alice", slug: "game" });
    expect(directNameService("johngame.fshp.app")).toBeNull();
    const app = { serviceId: "alice--game" } as never;
    const platform = { byServiceId: (id: string) => (id === "alice--game" ? app : undefined) };
    const held = { has: (n: string) => n.toLowerCase() === NAME };
    const viaPlatform = (sni: string) => directApp(sni, held, platform as never);
    expect(viaPlatform("other--alice.fshp.app")).toBeUndefined();
    expect(directApp(NAME, null, platform as never)).toBeUndefined();
    expect(viaPlatform(NAME)).toBe(app);
  });
});

describe("one certificate per direct name through .com", () => {
  it("orders, installs, stores, reuses and does not renew early", async () => {
    const sqlite = createSqliteD1();
    const db = sqlite as unknown as D1Database;
    const storage = new D1Storage(db);
    const dir = await mkdtemp(join(tmpdir(), "direct-certs-"));
    try {
      await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1, adminRootPubHex: hex(admin.publicKey) });
      await storage.servers.put({ serverDomain: SERVER, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
      const o = nameOrder();
      await storage.directAccess.putNameIfNewer({
        name: "game--alice",
        username: "alice",
        kind: "derived",
        serverDomain: SERVER,
        enabled: true,
        orderJson: JSON.stringify(o),
        signatureHex: hex(signDirectNameOrder(o, admin)),
        issuedAt: o.issuedAt,
        now: 1,
      });
      const dns = new FakeDns();
      const ca = new FakeAcme(dns);
      const clock = { t: Date.now() };
      const env = { DB: db, ISSUANCE_ACME_ACCOUNT_KEY: await accountKeyPem(), ISSUANCE_ACME_DIRECTORY: ca.directory, SERVICES_APEX: "flagship.services" };
      const deps = { usernames: storage.usernames, grants: storage.deviceCapabilityGrants, dns, directDns: dns, fetchImpl: ca.fetch as typeof fetch, now: () => clock.t, propagationMs: 0, challengeQuietMs: 0 };
      const bodies: Array<Record<string, unknown>> = [];
      const comFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST" && String(input).endsWith("/api/certificates/orders")) bodies.push(JSON.parse(String(init.body)));
        return (await tryIssuanceRoute(new Request(String(input), init), env, deps)) ?? new Response("{}", { status: 404 });
      }) as typeof fetch;
      const issuer = new ServiceIssuer({
        controlPlaneBaseUrl: "https://flagshipserver.com",
        serverFqdn: SERVER,
        boxPubHex: hex(stk.publicKey),
        signAsBox: (m) => ed.sign(m, stk.privateKey),
        regGen: () => 1,
        wildcardGrant: () => undefined,
        csr: localCsrSource(),
        fetchImpl: comFetch,
        now: () => clock.t,
        sleep: async (ms) => {
          clock.t += ms;
        },
      });
      const certManager = new CertManager();
      const store = new PersistentAcmeStore(dir);
      const certs = new DirectCertificates({ issuer, certManager, store, names: () => [NAME], now: () => clock.t, log: () => {} });
      await certs.tick();
      expect(certs.has(NAME)).toBe(true);
      expect(certManager.contextFor(NAME)).not.toBeNull();
      expect(certManager.contextFor("other--alice.fshp.app")).toBeNull();
      expect(bodies[0]).toMatchObject({ directName: NAME, order: { class: "direct" } });
      expect(dns.written).toEqual([`_acme-challenge.${NAME}`]);

      await certs.tick();
      expect(bodies.length).toBe(1);

      const again = new CertManager();
      const restarted = new DirectCertificates({ issuer, certManager: again, store, names: () => [NAME], now: () => clock.t, log: () => {} });
      await restarted.tick();
      expect(again.contextFor(NAME)).not.toBeNull();
      expect(bodies.length).toBe(1);

      const refused = new DirectCertificates({ issuer, certManager: new CertManager(), names: () => ["nope--alice.fshp.app"], now: () => clock.t, log: () => {} });
      await refused.tick();
      expect(refused.has("nope--alice.fshp.app")).toBe(false);
      await refused.tick();
      expect(bodies.filter((b) => b.directName === "nope--alice.fshp.app").length).toBe(1);
    } finally {
      sqlite.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
