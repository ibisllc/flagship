import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentAcmeStore, isCertFresh } from "../src/acme/persistentStore.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flagship-acme-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PersistentAcmeStore — account key", () => {
  it("returns null when no account key is on disk", async () => {
    const s = new PersistentAcmeStore(dir);
    expect(await s.loadAccountKey()).toBeNull();
  });

  it("save then load returns the same PEM", async () => {
    const s = new PersistentAcmeStore(dir);
    const pem = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
    await s.saveAccountKey(pem);
    expect(await s.loadAccountKey()).toBe(pem);
  });

  it("writes account.pem with mode 0o600 inside acme/ with mode 0o700", async () => {
    const s = new PersistentAcmeStore(dir);
    await s.saveAccountKey("k");
    const acmeDir = await stat(join(dir, "acme"));
    expect(acmeDir.mode & 0o777).toBe(0o700);
    const file = await stat(join(dir, "acme", "account.pem"));
    expect(file.mode & 0o777).toBe(0o600);
  });
});

describe("PersistentAcmeStore — cert", () => {
  const fqdn = "home.alice.flagship.services";

  it("returns null when no cert is on disk", async () => {
    const s = new PersistentAcmeStore(dir);
    expect(await s.loadCert(fqdn)).toBeNull();
  });

  it("roundtrips cert + key + meta", async () => {
    const s = new PersistentAcmeStore(dir);
    const notAfter = Date.now() + 90 * 24 * 60 * 60_000;
    await s.saveCert(fqdn, {
      certPem: "-----CERT-----",
      privateKeyPem: "-----KEY-----",
      names: [fqdn, `*.${fqdn}`],
      notAfter,
    });
    const got = await s.loadCert(fqdn);
    expect(got).not.toBeNull();
    expect(got!.certPem).toBe("-----CERT-----");
    expect(got!.privateKeyPem).toBe("-----KEY-----");
    expect(got!.names).toEqual([fqdn, `*.${fqdn}`]);
    expect(got!.notAfter).toBe(notAfter);
    expect(got!.issuedAt).toBeGreaterThan(0);
  });

  it("returns null if meta.json is absent (write order: cert, key, meta — so partial write looks pristine)", async () => {
    const s = new PersistentAcmeStore(dir);
    const notAfter = Date.now() + 90 * 24 * 60 * 60_000;
    await s.saveCert(fqdn, {
      certPem: "c",
      privateKeyPem: "k",
      names: [fqdn],
      notAfter,
    });
    // Simulate a crash that lost meta.json by deleting it.
    const metaPath = join(dir, "acme", "cert", `${fqdn}.meta.json`);
    await rm(metaPath);
    expect(await s.loadCert(fqdn)).toBeNull();
  });

  it("sanitizes the FQDN so a hostile name can't escape the cert dir", async () => {
    const s = new PersistentAcmeStore(dir);
    const evil = "../../etc/passwd";
    await s.saveCert(evil, {
      certPem: "x",
      privateKeyPem: "y",
      names: [evil],
      notAfter: Date.now() + 1000,
    });
    // The slashes must be replaced — otherwise the write would escape
    // the cert dir. (The `..` substrings inside the filename are
    // harmless because the path separators are gone.)
    const certDirEntries = await readdir(join(dir, "acme", "cert"));
    expect(certDirEntries.length).toBeGreaterThan(0);
    for (const f of certDirEntries) {
      expect(f.includes("/")).toBe(false);
    }
    // Loading the original (pre-sanitized) name should succeed because
    // saveCert and loadCert apply the same transform.
    const back = await s.loadCert(evil);
    expect(back).not.toBeNull();
  });
});

describe("isCertFresh", () => {
  it("returns false when expiry is sooner than the window", () => {
    const now = 1_000_000;
    const cert = {
      certPem: "",
      privateKeyPem: "",
      names: [],
      notAfter: now + 5_000,
      issuedAt: now,
    };
    expect(isCertFresh(cert, 10_000, now)).toBe(false);
  });

  it("returns true when expiry is past the window", () => {
    const now = 1_000_000;
    const cert = {
      certPem: "",
      privateKeyPem: "",
      names: [],
      notAfter: now + 100_000,
      issuedAt: now,
    };
    expect(isCertFresh(cert, 10_000, now)).toBe(true);
  });
});
