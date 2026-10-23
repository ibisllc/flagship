import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealForEd25519Recipient, ed } from "@flagship/protocol";
import { AcmeAccount, KeydClient, KeydServer, KeydService, TlsKeys } from "@flagship/keyd";
import { KeydAcmeIssuer, AcmeProblem } from "../src/acme/keydAcme.js";
import { keydAcmeApi } from "../src/keydAsync.js";
import { MockAcme } from "./helpers/mockAcme.js";

const FQDN = "home.alice.flagship.services";
const NAMES = [FQDN, `*.${FQDN}`];
const SEED = new Uint8Array(32).fill(0x61);

let dir: string;
let server: KeydServer;
let client: KeydClient;
let tls: TlsKeys;
let acct: AcmeAccount;
let mock: MockAcme;
let issuer: KeydAcmeIssuer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "keyd-acme-"));
  tls = new TlsKeys(new Set(NAMES), join(dir, "tls"));
  acct = new AcmeAccount(tls, new Set(["acme.test"]), join(dir, "acme.key"));
  const service = new KeydService({ identitySeed: SEED, tls, acme: acct });
  server = new KeydServer({ socketPath: join(dir, "k.sock"), service, rateLimits: { "*": { perSecond: 10000, burst: 10000 } } });
  await server.start();
  client = new KeydClient({ socketPath: join(dir, "k.sock"), component: "acme" });
  await client.connect();
  mock = new MockAcme();
  issuer = new KeydAcmeIssuer({
    keyd: keydAcmeApi(client),
    directoryUrl: "https://acme.test/directory",
    email: "ops@example.com",
    dns: {
      publishTxt: async (host, value) => {
        (mock.txt.get(host) ?? mock.txt.set(host, new Set()).get(host)!).add(value);
        return async () => {
          mock.txt.get(host)?.delete(value);
          if (mock.txt.get(host)?.size === 0) mock.txt.delete(host);
        };
      },
    },
    fetchImpl: mock.fetch,
    dns01PropagationDelayMs: 0,
    pollIntervalMs: 1,
  });
});
afterEach(async () => {
  client.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("issuing a certificate with the keys in keyd", () => {
  it("runs the whole order: account, order, DNS-01, finalize with keyd's CSR, install", async () => {
    const out = await issuer.issue(NAMES);
    expect(out.handle).toMatch(/^[0-9a-f]{32}$/);
    const leaf = new X509Certificate(out.chainPem);
    expect((leaf.subjectAltName ?? "").split(", ").map((s) => s.replace("DNS:", "")).sort()).toEqual([...NAMES].sort());
    expect(out.notAfter).toBeGreaterThan(Date.now());
    // keyd accepted it for that key and can now serve with it.
    await client.call("tls.activate", { handle: out.handle });
    expect((await client.call("tls.active")).active).toMatchObject({ handle: out.handle });
    // The protocol steps happened in order and every JWS verified at the server (an invalid one would 4xx).
    const kinds = mock.log.requests.map((r) => r.kind).filter(Boolean);
    expect(kinds[0]).toBe("newAccount");
    expect(kinds).toContain("newOrder");
    expect(kinds).toContain("finalize");
    expect(kinds.at(-1)).toBe("cert");
    // The DNS records were cleaned up afterwards.
    expect(mock.txt.size).toBe(0);
  });

  it("reuses the account for a second order", async () => {
    await issuer.issue(NAMES);
    await issuer.issue([FQDN]);
    expect(mock.log.requests.filter((r) => r.kind === "newAccount")).toHaveLength(1);
  });

  it("retries once on badNonce, which the protocol requires", async () => {
    mock.failBadNonceOnce = true;
    const out = await issuer.issue([FQDN]);
    expect(out.handle).toBeTruthy();
  });

  it("fails cleanly, and still removes its DNS records, when the CA rejects the challenge", async () => {
    mock.invalidateDns = true;
    await expect(issuer.issue(NAMES)).rejects.toThrow(/validation failed/);
    expect(mock.txt.size).toBe(0);
  });

  it("cannot be used to get a certificate for a name the box may not have", async () => {
    await expect(issuer.issue(["evil.example.com"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(issuer.issue([FQDN, "evil.example.com"])).rejects.toMatchObject({ code: "forbidden" });
    expect(mock.log.requests.filter((r) => r.kind === "newOrder")).toHaveLength(0);
  });

  it("keyd refuses to sign requests of any shape but the known ones, or to hosts it does not talk to", async () => {
    await issuer.issue([FQDN]);
    const kid = "https://acme.test/acme/acct/acct1";
    const bad: Array<Record<string, unknown>> = [
      { kind: "newOrder", url: "https://evil.example/acme/new-order", nonce: "abcdefghij", kid, names: [FQDN] },
      { kind: "newOrder", url: "http://acme.test/acme/new-order", nonce: "abcdefghij", kid, names: [FQDN] },
      { kind: "newOrder", url: "https://acme.test:8443/acme/new-order", nonce: "abcdefghij", kid, names: [FQDN] },
      { kind: "newOrder", url: "https://acme.test/acme/new-order", nonce: "abcdefghij", kid: "https://acme.test/other", names: [FQDN] },
      { kind: "finalize", url: "https://acme.test/acme/new-order", nonce: "abcdefghij", kid, handle: "00".repeat(16) },
      { kind: "newAccount", url: "https://acme.test/acme/new-acct", nonce: "abcdefghij", contact: "mailto:a@b.c\nmailto:x@y.z" },
      { kind: "newAccount", url: "https://acme.test/acme/new-acct", nonce: "x", contact: "mailto:a@example.com" },
      { kind: "anything", url: "https://acme.test/x", nonce: "abcdefghij" },
    ];
    for (const args of bad) await expect(client.call("acme.sign", args), JSON.stringify(args)).rejects.toThrow();
  });

  it("revokes only one of the box's own certificates", async () => {
    const out = await issuer.issue([FQDN]);
    const der = new X509Certificate(out.chainPem).raw;
    await issuer.revoke(der, 1);
    expect(mock.revoked).toHaveLength(1);
    const other = new X509Certificate(await foreignCertPem());
    await expect(issuer.revoke(other.raw, 1)).rejects.toThrow();
    await expect(client.call("acme.sign", { kind: "revoke", url: "https://acme.test/acme/revoke-cert", nonce: "abcdefghij", kid: "https://acme.test/acme/acct/acct1", certificate: Buffer.from(der).toString("hex"), reason: 3 })).rejects.toMatchObject({ code: "bad-request" });
  });

  it("never returns the account key or a TLS private key to the caller", async () => {
    await issuer.issue([FQDN]);
    const seen = JSON.stringify([await client.call("acme.jwk"), await client.call("tls.list")]);
    expect(seen).not.toMatch(/"d"|priv/i);
  });
});

describe("a granted account key", () => {
  it("is opened inside keyd from a blob sealed to the box and then used for orders", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = k.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const blob = sealForEd25519Recipient(new TextEncoder().encode(pem), ed.getPublicKey(SEED));
    const r = await client.call("acme.importGranted", { blob: Buffer.from(blob).toString("hex") });
    expect((r.jwk as { crv: string }).crv).toBe("P-256");
    await expect(client.call("acme.importGranted", { blob: Buffer.from(blob).toString("hex") })).rejects.toMatchObject({ code: "forbidden" });
    const out = await issuer.issue([FQDN]);
    expect(out.handle).toBeTruthy();
  });

  it("is refused when it is not a P-256 key or not sealed to this box", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const toBox = (pem: string) => Buffer.from(sealForEd25519Recipient(new TextEncoder().encode(pem), ed.getPublicKey(SEED))).toString("hex");
    await expect(client.call("acme.importGranted", { blob: toBox(rsa) })).rejects.toMatchObject({ code: "bad-request" });
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const other = Buffer.from(sealForEd25519Recipient(new TextEncoder().encode(ec), ed.getPublicKey(new Uint8Array(32).fill(1)))).toString("hex");
    await expect(client.call("acme.importGranted", { blob: other })).rejects.toMatchObject({ code: "failed" });
  });
});

void AcmeProblem;

async function foreignCertPem(): Promise<string> {
  const { X509CertificateGenerator, cryptoProvider } = await import("@peculiar/x509");
  cryptoProvider.set(globalThis.crypto);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "09", name: "CN=evil.example.com", notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86400_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keys,
    extensions: [new (await import("@peculiar/x509")).SubjectAlternativeNameExtension([{ type: "dns", value: "evil.example.com" }])],
  });
  return cert.toString("pem");
}
