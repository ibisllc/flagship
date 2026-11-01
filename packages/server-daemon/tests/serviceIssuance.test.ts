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

  it("with the key in keyd: installs both and keeps the app certificate active when it also covers the box's name", async () => {
    const w = await world({ grant: true });
    try {
      const keys = new Map<string, { names: string[]; keys: CryptoKeyPair; chain?: string; notAfter?: number }>();
      let active: string | null = null;
      let n = 0;
      const keyd: KeydCertSlots = {
        install: async (h, chain) => {
          const k = keys.get(h)!;
          k.chain = chain;
          k.notAfter = Date.parse(new X509Certificate(chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)![0]).validTo);
          return { notAfter: k.notAfter, names: k.names };
        },
        activate: async (h) => {
          active = h;
        },
        list: async () => [...keys].map(([handle, k]) => ({ handle, names: k.names, notAfter: k.notAfter ?? null, active: handle === active, legacy: false })),
        active: async () => {
          const k = active ? keys.get(active) : undefined;
          return k?.chain ? { handle: active!, chainPem: k.chain, notAfter: k.notAfter!, names: k.names } : null;
        },
      };
      const csr = keydCsrSource({
        tlsCreateKey: async (names) => {
          const handle = (++n).toString(16).padStart(32, "0");
          keys.set(handle, { names, keys: (await makeCsr(names)).keys });
          return { handle };
        },
        tlsCsr: async (h) => (await makeCsr(keys.get(h)!.names, { keys: keys.get(h)!.keys })).der,
      });
      const certs = new BoxCertificates({ issuer: w.issuer(csr), serverFqdn: SERVER, certManager: new CertManager(), keyd, now: () => w.clock.t, random: () => 0 });
      await certs.tick();
      expect(keys.size).toBe(2);
      expect(keys.get(active!)!.names.sort()).toEqual([`*.alice.${APEX}`, `*.${SERVER}`]);
    } finally {
      w.close();
    }
  });
});
