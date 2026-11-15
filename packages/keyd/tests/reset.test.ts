import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeydService, ensureRetailFirstIdentity, readKeyFile, resetKeydState } from "../src/index.js";

function ownedState(): string {
  const dir = mkdtempSync(join(tmpdir(), "keyd-reset-"));
  for (const f of ["identity", "identity-mldsa", "swk", "cgk"]) writeFileSync(join(dir, `${f}.key`), "11".repeat(32) + "\n", { mode: 0o400 });
  for (const f of ["policy.json", "owner.json", "archive-keks.json", "revocations.json", "ca-keys.json", "revocation-list.json", "audit.log", "acme-account.key", "provision-ceremony.token"]) writeFileSync(join(dir, f), "{\"previous\":\"owner\"}");
  mkdirSync(join(dir, "tls"));
  writeFileSync(join(dir, "tls", "home.alice.flagship.services.key"), "old tls key");
  return dir;
}

describe("keyd reset", () => {
  it("leaves only a fresh STK and ML-DSA seed, readable by the serving keyd", () => {
    const dir = ownedState();
    const old = new KeydService({ identitySeed: readKeyFile(join(dir, "identity.key"))! });
    const r = resetKeydState(dir);
    expect(readdirSync(dir).sort()).toEqual(["identity-mldsa.key", "identity.key"]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o400);
    const seed = readKeyFile(join(dir, "identity.key"))!;
    const pq = readKeyFile(join(dir, "identity-mldsa.key"))!;
    const fresh = new KeydService({ identitySeed: seed, pqSeed: pq });
    expect(fresh.publicKeyHex).toBe(r.publicKeyHex);
    expect(fresh.publicKeyHex).not.toBe(old.publicKeyHex);
    expect(Buffer.from(seed).toString("hex")).not.toBe(Buffer.from(pq).toString("hex"));
  });

  it("two resets never give the same key, and an empty or missing folder works", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "keyd-reset-")), "state");
    const a = resetKeydState(dir);
    const b = resetKeydState(dir);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.mldsaPubHex).not.toBe(b.mldsaPubHex);
  });
});

/** A retail image as the factory leaves it: the marker, an empty keyd folder, no box key anywhere. */
function retailImage(): string {
  const root = mkdtempSync(join(tmpdir(), "retail-image-"));
  mkdirSync(join(root, "etc/flagship"), { recursive: true });
  writeFileSync(join(root, "etc/flagship/retail-image.json"), JSON.stringify({ v: 1, dataLuksDevice: null, recoveryPartition: null }));
  mkdirSync(join(root, "var/lib/flagship-keyd"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "var/flagship"), { recursive: true });
  return root;
}

function boxFrom(image: string): { keydDir: string; legacyDir: string; retailMarker: string } {
  const root = mkdtempSync(join(tmpdir(), "retail-box-"));
  cpSync(image, root, { recursive: true });
  return { keydDir: join(root, "var/lib/flagship-keyd"), legacyDir: join(root, "var/flagship"), retailMarker: join(root, "etc/flagship/retail-image.json") };
}

function servedKey(keydDir: string): string {
  return new KeydService({ identitySeed: readKeyFile(join(keydDir, "identity.key"))!, pqSeed: readKeyFile(join(keydDir, "identity-mldsa.key"))! }).publicKeyHex;
}

describe("retail first boot", () => {
  it("two boxes written from one image make different identities, kept across restarts", () => {
    const image = retailImage();
    expect(readdirSync(join(image, "var/lib/flagship-keyd"))).toEqual([]);
    const a = boxFrom(image);
    const b = boxFrom(image);
    const ka = ensureRetailFirstIdentity(a)!;
    const kb = ensureRetailFirstIdentity(b)!;
    expect(ka.publicKeyHex).not.toBe(kb.publicKeyHex);
    expect(ka.mldsaPubHex).not.toBe(kb.mldsaPubHex);
    expect(servedKey(a.keydDir)).toBe(ka.publicKeyHex);
    expect(servedKey(b.keydDir)).toBe(kb.publicKeyHex);
    for (const f of readdirSync(a.keydDir)) expect(statSync(join(a.keydDir, f)).mode & 0o777).toBe(0o400);
    // Every later keyd start runs migrate again: the box keeps the key it registered.
    expect(ensureRetailFirstIdentity(a)).toBeNull();
    expect(servedKey(a.keydDir)).toBe(ka.publicKeyHex);
    // The image itself never gains a key.
    expect(readdirSync(join(image, "var/lib/flagship-keyd"))).toEqual([]);
  });

  it("a wiped box gets a new identity, unlike its old one and its sibling's", () => {
    const image = retailImage();
    const a = boxFrom(image);
    const b = boxFrom(image);
    const first = ensureRetailFirstIdentity(a)!;
    const sibling = ensureRetailFirstIdentity(b)!;
    const wiped = resetKeydState(a.keydDir);
    expect(wiped.publicKeyHex).not.toBe(first.publicKeyHex);
    expect(wiped.publicKeyHex).not.toBe(sibling.publicKeyHex);
    expect(servedKey(a.keydDir)).toBe(wiped.publicKeyHex);
    expect(ensureRetailFirstIdentity(a)).toBeNull();
    expect(servedKey(a.keydDir)).toBe(wiped.publicKeyHex);
  });

  it("makes nothing on a box that is not a retail image, or that holds an installer-made key", () => {
    const image = retailImage();
    const plain = boxFrom(image);
    expect(ensureRetailFirstIdentity({ ...plain, retailMarker: join(plain.legacyDir, "no-such-marker") })).toBeNull();
    expect(existsSync(join(plain.keydDir, "identity.key"))).toBe(false);
    const installed = boxFrom(image);
    mkdirSync(join(installed.legacyDir, "identity"));
    writeFileSync(join(installed.legacyDir, "identity", "identity.priv.hex"), "22".repeat(32), { mode: 0o600 });
    expect(ensureRetailFirstIdentity(installed)).toBeNull();
    expect(existsSync(join(installed.keydDir, "identity.key"))).toBe(false);
  });
});
