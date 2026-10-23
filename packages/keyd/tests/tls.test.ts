import "reflect-metadata";
import { generateKeyPairSync, createSign, X509Certificate, createVerify, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pkcs10CertificateRequest, X509CertificateGenerator, X509Certificate as PecX509, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags, SubjectAlternativeNameExtension, cryptoProvider } from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha256";
import { KeydClient, TlsKeys } from "../src/index.js";
import { SEED, startInProcess } from "./helpers.js";

const FQDN = "home.alice.flagship.services";
const ALLOWED = new Set([FQDN, `*.${FQDN}`]);
const sansOf = (csr: Pkcs10CertificateRequest): string[] => {
  const ext = csr.extensions.find((e) => e.type === "2.5.29.17")!;
  return new SubjectAlternativeNameExtension(ext.rawData).names.items.map((n) => n.value);
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A throwaway CA that issues a leaf for whatever public key a CSR carries. */
async function issueFor(csrDer: Uint8Array, opts: { names?: string[]; days?: number; notBeforeOffsetMs?: number } = {}): Promise<string> {
  cryptoProvider.set(globalThis.crypto);
  const ca = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const caCert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01", name: "CN=Test CA", notBefore: new Date(Date.now() - 86400_000), notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys: ca,
    extensions: [new BasicConstraintsExtension(true, undefined, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign)],
  });
  const csr = new Pkcs10CertificateRequest(Buffer.from(csrDer));
  expect(await csr.verify()).toBe(true);
  const names = opts.names ?? sansOf(csr);
  const leaf = await X509CertificateGenerator.create({
    serialNumber: "02", subject: csr.subject, issuer: caCert.subject, notBefore: new Date(Date.now() + (opts.notBeforeOffsetMs ?? -3600_000)), notAfter: new Date(Date.now() + (opts.days ?? 90) * 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, publicKey: csr.publicKey, signingKey: ca.privateKey,
    extensions: [new SubjectAlternativeNameExtension(names.map((value) => ({ type: "dns" as const, value })))],
  });
  return leaf.toString("pem") + "\n" + caCert.toString("pem") + "\n";
}

describe("TLS keys held by keyd", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "tls-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a key only for names this box may have, and a CSR for exactly those names", async () => {
    const tls = new TlsKeys(ALLOWED, dir);
    const { handle } = tls.createKey([FQDN, `*.${FQDN}`]);
    const csr = new Pkcs10CertificateRequest(Buffer.from(tls.csr(handle)));
    expect(await csr.verify()).toBe(true);
    const sans = sansOf(csr).sort();
    expect(sans).toEqual([FQDN, `*.${FQDN}`].sort());
    expect(csr.subject).toContain(FQDN);
    for (const bad of [["evil.example.com"], [FQDN, "evil.example.com"], ["*.example.com"], [], ["not a name"], [`x.${FQDN}`], ["*.*." + FQDN]]) {
      expect(() => tls.createKey(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("accepts a certificate for its own key and names, serves it, and signs handshakes only then", async () => {
    const tls = new TlsKeys(ALLOWED, dir);
    const { handle } = tls.createKey([FQDN]);
    const digest = sha256(new TextEncoder().encode("handshake transcript"));
    expect(() => tls.sign(handle, digest)).toThrow(/no certificate/);
    expect(() => tls.activate(handle)).toThrow(/install a certificate/);
    const chain = await issueFor(tls.csr(handle));
    const info = tls.install(handle, chain);
    expect(info.names).toEqual([FQDN]);
    tls.activate(handle);
    expect(tls.active()).toMatchObject({ handle, names: [FQDN] });
    const sig = tls.sign(handle, digest);
    const leaf = new X509Certificate(chain);
    const pub = leaf.publicKey;
    // The signature verifies under the certificate's key.
    const raw = pub.export({ type: "spki", format: "der" });
    expect(p256.verify(sig, digest, Uint8Array.from(Buffer.from(raw.subarray(raw.length - 65))), { prehash: false, format: "der" })).toBe(true);
    void createSign; void createVerify; void createPublicKey; void generateKeyPairSync; void PecX509;
  });

  it("refuses a certificate for another key, for more names, outside its dates, or without DNS names", async () => {
    const tls = new TlsKeys(ALLOWED, dir);
    const a = tls.createKey([FQDN]);
    const b = tls.createKey([FQDN]);
    const forB = await issueFor(tls.csr(b.handle));
    expect(() => tls.install(a.handle, forB)).toThrow(/not for this key/);
    const wide = await issueFor(tls.csr(a.handle), { names: [FQDN, "evil.example.com"] });
    expect(() => tls.install(a.handle, wide)).toThrow(/more than this key/);
    const expired = await issueFor(tls.csr(a.handle), { days: -2 });
    expect(() => tls.install(a.handle, expired)).toThrow(/not valid now/);
    const future = await issueFor(tls.csr(a.handle), { notBeforeOffsetMs: 3 * 86400_000 });
    expect(() => tls.install(a.handle, future)).toThrow(/not valid now/);
    expect(() => tls.install(a.handle, "not a chain")).toThrow(/chain/);
  });

  it("survives a restart: keys, certificate and the key in service", async () => {
    const t1 = new TlsKeys(ALLOWED, dir);
    const { handle } = t1.createKey([FQDN]);
    t1.install(handle, await issueFor(t1.csr(handle)));
    t1.activate(handle);
    const t2 = new TlsKeys(ALLOWED, dir);
    expect(t2.active()?.handle).toBe(handle);
    expect(t2.sign(handle, sha256(new Uint8Array(1)))).toBeInstanceOf(Uint8Array);
    expect(() => t2.remove(handle)).toThrow(/in service/);
  });

  it("works over the socket and never returns the private key", async () => {
    const k = await startInProcess({ tls: new TlsKeys(ALLOWED) }, { rateLimits: { "*": { perSecond: 1000, burst: 1000 } } });
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "acme" });
      await c.connect();
      const created = await c.call("tls.createKey", { names: [FQDN, `*.${FQDN}`] });
      const csr = Uint8Array.from(Buffer.from(String((await c.call("tls.csr", { handle: created.handle })).csr), "hex"));
      await c.call("tls.install", { handle: created.handle, chain: await issueFor(csr) });
      await c.call("tls.activate", { handle: created.handle });
      const listed = await c.call("tls.list");
      expect(JSON.stringify(listed)).not.toMatch(/priv/i);
      expect((await c.call("tls.active")).active).toMatchObject({ handle: created.handle });
      await expect(c.call("tls.createKey", { names: ["evil.example.com"] })).rejects.toMatchObject({ code: "forbidden" });
      await expect(c.call("tls.sign", { handle: created.handle, digest: "00" })).rejects.toMatchObject({ code: "bad-request" });
      const sig = await c.call("tls.sign", { handle: created.handle, digest: hex(sha256(new Uint8Array(3))) });
      expect(String(sig.sig).length).toBeGreaterThan(100);
      c.close();
    } finally {
      await k.stop();
    }
  });

  it("is absent when keyd was started without TLS", async () => {
    const k = await startInProcess();
    try {
      const c = new KeydClient({ socketPath: k.sock, component: "t" });
      await c.connect();
      await expect(c.call("tls.list")).rejects.toMatchObject({ code: "not-provisioned" });
      c.close();
    } finally {
      await k.stop();
    }
  });
});

void SEED;

describe("taking over an upgraded box's certificate", () => {
  it("imports a P-256 key and certificate, serves it flagged legacy, and refuses what is not this box's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tls-legacy-"));
    try {
      const { generateKeyPairSync } = await import("node:crypto");
      cryptoProvider.set(globalThis.crypto);
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const mk = async (names: string[], k = keys) =>
        (await X509CertificateGenerator.createSelfSigned({
          serialNumber: "05", name: `CN=${names[0]}`, notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 80 * 86400_000),
          signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys: k,
          extensions: [new SubjectAlternativeNameExtension(names.map((value) => ({ type: "dns" as const, value })))],
        })).toString("pem");
      const pkcs8 = async (k: CryptoKeyPair) => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
      const tls = new TlsKeys(ALLOWED, dir);
      const r = tls.importLegacy(await pkcs8(keys), await mk([FQDN, `*.${FQDN}`]));
      expect(r.names).toEqual([FQDN, `*.${FQDN}`].sort());
      expect(tls.active()).toMatchObject({ handle: r.handle, legacy: true });
      expect(tls.sign(r.handle, sha256(new Uint8Array(2)))).toBeInstanceOf(Uint8Array);
      expect(tls.list()[0]).toMatchObject({ legacy: true, active: true });
      // Not this box's names, not the certificate's key, not P-256.
      const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      await expect(async () => new TlsKeys(ALLOWED).importLegacy(await pkcs8(keys), await mk(["evil.example.com"]))).rejects.toThrow(/more than this box/);
      await expect(async () => new TlsKeys(ALLOWED).importLegacy(await pkcs8(other), await mk([FQDN], keys))).rejects.toThrow(/not the certificate/);
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      expect(() => new TlsKeys(ALLOWED).importLegacy(rsa, "x")).toThrow(/P-256/);
      // Survives a restart still flagged, and the key can be removed once it is not in service.
      const again = new TlsKeys(ALLOWED, dir);
      expect(again.active()?.legacy).toBe(true);
      const fresh = again.createKey([FQDN]);
      again.install(fresh.handle, await issueFor(again.csr(fresh.handle)));
      again.activate(fresh.handle);
      again.remove(r.handle);
      expect(again.list().map((k) => k.legacy)).toEqual([false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
