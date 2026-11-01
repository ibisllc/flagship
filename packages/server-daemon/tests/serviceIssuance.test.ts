/**
 * The box's side of the issuance service (acme/serviceIssuer.ts, acme/boxCertificates.ts) against the real `.com`
 * route (apps/com/src/certificateIssuance.ts over sqlite D1) and a fake ACME CA: the box gets a control certificate for
 * exactly its name and an app certificate for its wildcards, serves each by SNI, reuses them across restarts and
 * never orders before they are due.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { D1Storage, type D1Database } from "@flagship/storage";
import { ed, signServerWildcardGrant } from "@flagship/protocol";
import { createSqliteD1 } from "../../storage/tests/support/sqliteD1.js";
import { tryIssuanceRoute } from "../../../apps/com/src/certificateIssuance.js";
import { accountKeyPem, FakeAcme, FakeDns, makeCsr } from "../../../apps/com/test/support/fakeAcme.js";
import { CertManager } from "../src/certManager.js";
import { PersistentAcmeStore } from "../src/acme/persistentStore.js";
import { BoxCertificates, type KeydCertSlots } from "../src/acme/boxCertificates.js";
import { IssuanceDeferred, keydCsrSource, localCsrSource, ServiceIssuer, type CsrSource } from "../src/acme/serviceIssuer.js";
import { TlsKeys, namesFor, type TlsSlot } from "@flagship/keyd";

const APEX = "flagship.services";
const SERVER = `home.alice.${APEX}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ADMIN = new Uint8Array(32).fill(1);
const BOX_KEY = new Uint8Array(32).fill(9);
const BOX = hex(ed.getPublicKey(BOX_KEY));

async function world(o: { grant?: boolean } = {}) {
  const sqlite = createSqliteD1();
  const db = sqlite as unknown as D1Database;
  const storage = new D1Storage(db);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(ed.getPublicKey(new Uint8Array(32).fill(5))), claimedAt: 1, adminRootPubHex: hex(ed.getPublicKey(ADMIN)) });
  await storage.servers.put({ serverDomain: SERVER, username: "alice", identityPubKeyHex: BOX, registeredAt: 1 });
  const dns = new FakeDns();
  const ca = new FakeAcme(dns);
  const clock = { t: Date.now() };
  const env = { DB: db, ISSUANCE_ACME_ACCOUNT_KEY: await accountKeyPem(), ISSUANCE_ACME_DIRECTORY: ca.directory, SERVICES_APEX: APEX };
  const deps = { usernames: storage.usernames, grants: storage.deviceCapabilityGrants, dns, fetchImpl: ca.fetch as typeof fetch, now: () => clock.t, propagationMs: 0 };
  const comFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await tryIssuanceRoute(new Request(String(input), init), env, deps);
    return res ?? new Response("{}", { status: 404 });
  }) as typeof fetch;
  const grant = o.grant
    ? (() => {
        const issuedAt = clock.t - 1000;
        return { issuedAt, signatureHex: hex(signServerWildcardGrant({ username: "alice", serverDomain: SERVER, stkPubHex: BOX, issuedAt }, (m) => ed.sign(m, ADMIN))) };
      })()
    : undefined;
  const issuer = (csr: CsrSource = localCsrSource()) =>
    new ServiceIssuer({
      controlPlaneBaseUrl: "https://flagshipserver.com",
      serverFqdn: SERVER,
      boxPubHex: BOX,
      signAsBox: (m) => ed.sign(m, BOX_KEY),
      regGen: () => 1,
      wildcardGrant: () => grant,
      csr,
      fetchImpl: comFetch,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
    });
  return { sqlite, ca, dns, clock, issuer, close: () => sqlite.close() };
}

/** keyd's real TLS key store behind the daemon's interfaces: keys never leave it, certificates are checked on install. */
function realKeyd() {
  const tls = new TlsKeys(new Set(namesFor(SERVER)));
  const keyd: KeydCertSlots = {
    install: async (h, chain) => tls.install(h, chain),
    activate: async (h, slot?: TlsSlot) => tls.activate(h, slot),
    serving: async () => tls.servingCerts().map((c) => ({ slot: c.slot, handle: c.handle })),
    list: async () => tls.list(),
    active: async () => tls.active(),
  };
  const csr = keydCsrSource({ tlsCreateKey: async (names) => ({ handle: tls.createKey(names).handle }), tlsCsr: async (h) => tls.csr(h) });
  const served = () => Object.fromEntries(tls.servingCerts().map((c) => [c.slot, c.names.slice().sort()]));
  return { tls, keyd, csr, served };
}

const sanOf = (pem: string) => new X509Certificate(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]).subjectAltName;

describe("box certificates through the issuance service", () => {
  it("gets a control and an app certificate, serves each by name, and reuses them across a restart", async () => {
    const w = await world({ grant: true });
    const dir = await mkdtemp(join(tmpdir(), "box-certs-"));
    try {
      const cm = new CertManager();
      const installed: string[] = [];
      const certs = new BoxCertificates({
        issuer: w.issuer(),
        serverFqdn: SERVER,
        certManager: cm,
        store: new PersistentAcmeStore(dir),
        now: () => w.clock.t,
        random: () => 0,
        onInstalled: (cls) => installed.push(cls),
      });
      await certs.tick();
      expect(installed).toEqual(["control", "apps"]);
      expect(w.ca.newOrders).toBe(2);
      expect(new Set(w.dns.written)).toEqual(new Set([`_acme-challenge.${SERVER}`, `_acme-challenge.alice.${APEX}`]));
      expect(cm.contextFor(SERVER)).not.toBeNull();
      expect(cm.contextFor(`app.${SERVER}`)).not.toBeNull();
      expect(sanOf(cm.currentCertPem()!)).toBe(`DNS:*.alice.${APEX}, DNS:*.${SERVER}`);

      // Nothing is due: no order, also not after a restart.
      await certs.tick();
      const restarted = new BoxCertificates({ issuer: w.issuer(), serverFqdn: SERVER, certManager: new CertManager(), store: new PersistentAcmeStore(dir), now: () => w.clock.t, random: () => 0 });
      await restarted.load();
      await restarted.tick();
      expect(w.ca.newOrders).toBe(2);
      expect(restarted.has("control") && restarted.has("apps")).toBe(true);

      // In the last third it renews (both classes).
      w.clock.t += 61 * 86_400_000;
      await restarted.tick();
      expect(w.ca.newOrders).toBe(4);
    } finally {
      w.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("asks only for its own wildcard without the admin's grant", async () => {
    const w = await world();
    try {
      const c = await w.issuer().issue("apps");
      expect(c.names).toEqual([`*.${SERVER}`]);
      expect(sanOf(c.chainPem)).toBe(`DNS:*.${SERVER}`);
    } finally {
      w.close();
    }
  });

  it("waits until .com's due date when it refuses an early order", async () => {
    const w = await world();
    try {
      const issuer = w.issuer();
      await issuer.issue("control");
      const early = await issuer.issue("control").then(
        () => null,
        (e: unknown) => e,
      );
      // A new key per class is let through once in 30 days; the third early order is refused.
      expect(early).toBeNull();
      const refused = await issuer.issue("control").then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(IssuanceDeferred);
      expect((refused as IssuanceDeferred).code).toBe("issuance-not-due");
      expect((refused as IssuanceDeferred).retryAt).toBeGreaterThan(w.clock.t + 50 * 86_400_000);
    } finally {
      w.close();
    }
  });

  it("with the key in keyd and the account wildcard: the app certificate is the default, and each class has its slot", async () => {
    const w = await world({ grant: true });
    try {
      const k = realKeyd();
      const certs = new BoxCertificates({ issuer: w.issuer(k.csr), serverFqdn: SERVER, certManager: new CertManager(), keyd: k.keyd, now: () => w.clock.t, random: () => 0 });
      await certs.tick();
      expect(k.tls.list()).toHaveLength(2);
      expect(k.served()).toEqual({ control: [SERVER], apps: [`*.alice.${APEX}`, `*.${SERVER}`], default: [`*.alice.${APEX}`, `*.${SERVER}`] });
    } finally {
      w.close();
    }
  });

  it("with the key in keyd and no account wildcard: the box's name keeps the control certificate and app names get the apps one (gym 20)", async () => {
    const w = await world();
    try {
      const k = realKeyd();
      const certs = new BoxCertificates({ issuer: w.issuer(k.csr), serverFqdn: SERVER, certManager: new CertManager(), keyd: k.keyd, now: () => w.clock.t, random: () => 0 });
      await certs.tick();
      expect(k.served()).toEqual({ control: [SERVER], apps: [`*.${SERVER}`], default: [SERVER] });
      // Steady state: another tick changes nothing.
      const before = k.tls.servingCerts().map((c) => c.handle);
      await certs.tick();
      expect(k.tls.servingCerts().map((c) => c.handle)).toEqual(before);
    } finally {
      w.close();
    }
  });

  it("with a keyd that serves only one certificate: the control one stays the default, as before slots", async () => {
    const w = await world();
    try {
      const k = realKeyd();
      const { serving: _gone, ...oneOnly } = k.keyd;
      void _gone;
      const certs = new BoxCertificates({ issuer: w.issuer(k.csr), serverFqdn: SERVER, certManager: new CertManager(), keyd: oneOnly, now: () => w.clock.t, random: () => 0 });
      await certs.tick();
      expect(k.served()).toEqual({ default: [SERVER] });
    } finally {
      w.close();
    }
  });
});
